//! Full-screen PostgreSQL-backed chat history navigator.
use anyhow::{Context, Result};
use crossterm::event::{self, Event, KeyCode, KeyEventKind, KeyModifiers};
use ratatui::{
    layout::{Constraint, Direction, Layout},
    style::{Color, Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, List, ListItem, ListState, Paragraph, Wrap},
    Terminal,
};
use ratatui::backend::CrosstermBackend;
use std::{io, time::Duration};
use uuid::Uuid;
use tokio_postgres::Client;
use crate::{fetch_messages, watcher_request};

#[derive(Clone)]
struct Turn {
    question: String,
    answers: String,
    answer_id: Option<Uuid>,
    question_id: Uuid,
    sequence: i32,
}
#[derive(Clone)]
struct CodeItem {
    question: String,
    body: String,
    language: String,
    source_id: Uuid,
    sequence: i32,
    number: usize,
}
#[derive(Clone, Copy, PartialEq, Eq)]
enum Tab { Questions, Code }

fn extract_code(text: &str) -> Vec<(String, String)> {
    let mut blocks = Vec::new();
    let mut in_block = false;
    let mut delim_char = '`';
    let mut delim_len = 3;
    let mut lang = String::new();
    let mut body = String::new();
    for line in text.lines() {
        let trim = line.trim_start();
        let ch = trim.chars().next().unwrap_or(' ');
        let count = trim.chars().take_while(|c| *c == ch).count();
        if !in_block && (ch == '`' || ch == '~') && count >= 3 {
            in_block = true;
            delim_char = ch;
            delim_len = count;
            lang = trim[count..].trim().to_owned();
            body.clear();
        } else if in_block && ch == delim_char && count >= delim_len && trim[count..].trim().is_empty() {
            blocks.push((lang.clone(), body.trim_end_matches('\n').to_owned()));
            in_block = false;
        } else if in_block {
            body.push_str(line);
            body.push('\n');
        }
    }
    blocks
}

fn fuzzy_positions(haystack: &str, needle: &str) -> Option<(i64, Vec<usize>)> {
    if needle.trim().is_empty() { return Some((0, vec![])); }
    let h: Vec<char> = haystack.chars().collect();
    let n: Vec<char> = needle.chars().flat_map(char::to_lowercase).collect();
    let mut pos = Vec::new();
    let mut offset = 0;
    let mut score = 0i64;
    for wanted in n {
        let found = (offset..h.len()).find(|&i| h[i].to_lowercase().next() == Some(wanted))?;
        score += 10;
        if pos.last().is_some_and(|&p| p + 1 == found) { score += 7; }
        if found == 0 || !h[found.saturating_sub(1)].is_alphanumeric() { score += 4; }
        pos.push(found);
        offset = found + 1;
    }
    score -= ((h.len().saturating_sub(pos.len())) / 12) as i64;
    Some((score, pos))
}

fn emphasis(text: &str, query: &str, max_chars: usize) -> Line<'static> {
    let chars: Vec<char> = text.chars().collect();
    let match_positions = fuzzy_positions(text, query).map(|x| x.1).unwrap_or_default();
    let first = match_positions.first().copied().unwrap_or(0);
    let start = if first >= max_chars { first.saturating_sub(max_chars / 3) } else { 0 };
    let end = chars.len().min(start + max_chars);
    let mut spans = Vec::new();
    if start != 0 { spans.push(Span::raw("…")); }
    for (idx, ch) in chars[start..end].iter().enumerate() {
        let real = idx + start;
        let s = if match_positions.contains(&real) {
            Style::default().fg(Color::Black).bg(Color::Yellow).add_modifier(Modifier::BOLD)
        } else { Style::default() };
        let visible = if *ch == '\n' || *ch == '\r' || *ch == '\t' { ' ' } else { *ch };
        spans.push(Span::styled(visible.to_string(), s));
    }
    if end < chars.len() { spans.push(Span::raw("…")); }
    Line::from(spans)
}

fn matches_question(turn: &Turn, query: &str) -> Option<i64> {
    let q = fuzzy_positions(&turn.question, query).map(|(s, _)| s);
    let a = fuzzy_positions(&turn.answers, query).map(|(s, _)| s);
    match (q, a) { (Some(x), Some(y)) => Some(x.max(y)), (Some(x), _) | (_, Some(x)) => Some(x), _ => None }
}

fn build_items(messages: &[crate::MsgRow]) -> (Vec<Turn>, Vec<CodeItem>) {
    let mut turns: Vec<Turn> = Vec::new();
    let mut code: Vec<CodeItem> = Vec::new();
    let mut current_question = String::new();
    let mut current_index: Option<usize> = None;
    for msg in messages {
        if msg.role == "user" {
            current_question = msg.content.clone();
            turns.push(Turn { question: msg.content.clone(), answers: String::new(), answer_id: None,
                question_id: msg.id, sequence: msg.sequence });
            current_index = Some(turns.len() - 1);
        } else if msg.role == "assistant" {
            if let Some(i) = current_index {
                let turn = &mut turns[i];
                if !turn.answers.is_empty() { turn.answers.push_str("\n\n"); }
                turn.answers.push_str(&msg.content);
                if turn.answer_id.is_none() { turn.answer_id = Some(msg.id); }
            }
        }
        for (number, (language, body)) in extract_code(&msg.content).into_iter().enumerate() {
            code.push(CodeItem { question: current_question.clone(), body, language,
                source_id: msg.id, sequence: msg.sequence, number });
        }
    }
    turns.reverse();
    code.reverse();
    (turns, code)
}

fn filtered_questions(turns: &[Turn], query: &str) -> Vec<usize> {
    let mut matches: Vec<(usize, i64)> = turns.iter().enumerate().filter_map(|(i, t)| matches_question(t, query).map(|s| (i, s))).collect();
    if !query.is_empty() { matches.sort_by(|a,b| b.1.cmp(&a.1).then(a.0.cmp(&b.0))); }
    matches.into_iter().map(|(i,_)| i).collect()
}
fn filtered_code(blocks: &[CodeItem], query: &str) -> Vec<usize> {
    let mut matches: Vec<(usize, i64)> = blocks.iter().enumerate().filter_map(|(i,c)| {
        let a = fuzzy_positions(&c.question,query).map(|x| x.0);
        let b = fuzzy_positions(&c.body,query).map(|x| x.0);
        let d = fuzzy_positions(&c.language,query).map(|x| x.0);
        [a,b,d].into_iter().flatten().max().map(|s| (i,s))
    }).collect();
    if !query.is_empty() { matches.sort_by(|a,b| b.1.cmp(&a.1).then(a.0.cmp(&b.0))); }
    matches.into_iter().map(|(i,_)| i).collect()
}

struct Model {
    tab: Tab,
    query: String,
    searching: bool,
    index: usize,
    status: String,
    questions: Vec<Turn>,
    code: Vec<CodeItem>,
    title: String,
}
impl Model {
    fn selected(&self) -> Option<Uuid> {
        match self.tab {
            Tab::Questions => filtered_questions(&self.questions,&self.query).get(self.index)
                .map(|&i| { let t=&self.questions[i]; t.answer_id.unwrap_or(t.question_id) }),
            Tab::Code => filtered_code(&self.code,&self.query).get(self.index)
                .map(|&i| self.code[i].source_id),
        }
    }
    fn count(&self) -> usize { match self.tab {
        Tab::Questions => filtered_questions(&self.questions,&self.query).len(),
        Tab::Code => filtered_code(&self.code,&self.query).len(),
    }}
    fn clamp(&mut self) { self.index = self.index.min(self.count().saturating_sub(1)); }
    fn change_tab(&mut self) { self.tab = if self.tab == Tab::Questions {Tab::Code} else {Tab::Questions}; self.index=0; }
}

fn draw(frame: &mut ratatui::Frame, m: &Model) {
    let parts = Layout::default().direction(Direction::Vertical)
        .constraints([Constraint::Length(2),Constraint::Length(3),Constraint::Min(3),Constraint::Length(2)])
        .split(frame.area());
    let tab_title = format!(" {}   [1] Questions ({})   [2] Code blocks ({}) ", m.title, m.questions.len(), m.code.len());
    frame.render_widget(Paragraph::new(tab_title).style(Style::default().fg(Color::Cyan).add_modifier(Modifier::BOLD)),parts[0]);
    let prompt = if m.searching { "Search (type, Esc to stop): " } else { "Filter (/ to edit): " };
    frame.render_widget(Paragraph::new(format!("{prompt}{}", m.query))
        .block(Block::default().borders(Borders::ALL).title("Fuzzy search: questions + answers / code")), parts[1]);
    let width = parts[2].width.saturating_sub(9) as usize;
    let display_width = width.clamp(32,180);
    let mut list_state = ListState::default();
    if m.count()>0 { list_state.select(Some(m.index)); }
    let items: Vec<ListItem<'static>> = match m.tab {
        Tab::Questions => filtered_questions(&m.questions,&m.query).into_iter().map(|i| {
            let t = &m.questions[i];
            let mut lines = vec![Line::styled(format!("seq {}  Q {}", t.sequence, t.question_id),Style::default().fg(Color::Blue)),
                emphasis(&t.question,&m.query,display_width)];
            if !m.query.is_empty() && fuzzy_positions(&t.answers,&m.query).is_some() {
                lines.push(Line::styled("↳ matching assistant answer:",Style::default().fg(Color::Green)));
                lines.push(emphasis(&t.answers,&m.query,display_width));
            }
            lines.push(Line::raw(""));
            ListItem::new(lines)
        }).collect(),
        Tab::Code => filtered_code(&m.code,&m.query).into_iter().map(|i| {
            let b=&m.code[i];
            let mut lines=vec![Line::styled(format!("seq {}  {} #{}  · {}", b.sequence, b.language, b.number+1,b.source_id),Style::default().fg(Color::Blue)),
                emphasis(&format!("Q: {}",b.question),&m.query,display_width)];
            let mut shown=0;
            for line in b.body.lines() {
                if shown >= 4 { break; }
                lines.push(emphasis(line,&m.query,display_width));
                shown+=1;
            }
            if b.body.lines().count()>shown {lines.push(Line::raw("…"));}
            lines.push(Line::raw(""));
            ListItem::new(lines)
        }).collect(),
    };
    let list=List::new(items).block(Block::default().borders(Borders::ALL)
        .title(format!("{} | {} matches",if m.tab==Tab::Questions {"Questions"} else {"Code"},m.count())))
        .highlight_style(Style::default().bg(Color::DarkGray).add_modifier(Modifier::BOLD))
        .highlight_symbol("▶ ");
    frame.render_stateful_widget(list,parts[2],&mut list_state);
    frame.render_widget(Paragraph::new(format!("↑↓/jk select   Enter open answer   Tab switch   / filter   Esc clear   q quit   {}",m.status))
        .wrap(Wrap{trim:true}).style(Style::default().fg(Color::Gray)),parts[3]);
}

pub(crate) async fn run(client: &Client, chat_id: Uuid, title: String) -> Result<()> {
    let messages=fetch_messages(client,chat_id,false,0).await?;
    let (questions,code)=build_items(&messages);
    if questions.is_empty() && code.is_empty() { anyhow::bail!("no persisted messages for chat {chat_id}"); }
    let mut m=Model { tab:Tab::Questions,query:String::new(),searching:false,index:0,status:String::new(),questions,code,title };
    crossterm::terminal::enable_raw_mode()?;
    let mut stdout=io::stdout();
    crossterm::execute!(stdout,crossterm::terminal::EnterAlternateScreen,crossterm::event::EnableMouseCapture)?;
    let mut terminal=Terminal::new(CrosstermBackend::new(stdout))?;
    let result=(|| -> Result<()> {
        loop {
            terminal.draw(|frame|draw(frame,&m))?;
            if !event::poll(Duration::from_millis(300))? {continue;}
            let Event::Key(key)=event::read()? else {continue};
            if key.kind!=KeyEventKind::Press {continue;}
            if key.modifiers.contains(KeyModifiers::CONTROL) && key.code==KeyCode::Char('c') {break;}
            if m.searching {
                match key.code {
                    KeyCode::Esc | KeyCode::Enter => m.searching=false,
                    KeyCode::Backspace => {m.query.pop();m.index=0;},
                    KeyCode::Char(c) => {m.query.push(c);m.index=0;},
                    _ => {}
                }
                continue;
            }
            match key.code {
                KeyCode::Char('q') | KeyCode::Esc => {if m.query.is_empty(){break;}else{m.query.clear();m.index=0;}},
                KeyCode::Char('/') => m.searching=true,
                KeyCode::Tab => m.change_tab(),
                KeyCode::Char('1') => {m.tab=Tab::Questions;m.index=0;},
                KeyCode::Char('2') => {m.tab=Tab::Code;m.index=0;},
                KeyCode::Down | KeyCode::Char('j') => m.index=(m.index+1).min(m.count().saturating_sub(1)),
                KeyCode::Up | KeyCode::Char('k') => m.index=m.index.saturating_sub(1),
                KeyCode::PageDown => m.index=(m.index+10).min(m.count().saturating_sub(1)),
                KeyCode::PageUp => m.index=m.index.saturating_sub(10),
                KeyCode::Home => m.index=0,
                KeyCode::End => m.index=m.count().saturating_sub(1),
                KeyCode::Enter => {
                    if let Some(message_id)=m.selected() {
                        let payload=serde_json::json!({"chat_id":chat_id.to_string(),"message_id":message_id.to_string()}).to_string();
                        m.status=match watcher_request("POST","/jump-message",Some(&payload)) {
                            Ok(_) => format!("opened {message_id}"),
                            Err(err) => format!("open failed: {err:#}"),
                        };
                    }
                }
                _=>{}
            }
            m.clamp();
        }
        Ok(())
    })();
    crossterm::terminal::disable_raw_mode()?;
    crossterm::execute!(terminal.backend_mut(),crossterm::terminal::LeaveAlternateScreen,crossterm::event::DisableMouseCapture)?;
    terminal.show_cursor()?;
    result.context("Ratatui watch interface")
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn fuzzy_matches_subsequence() {
        assert!(fuzzy_positions("hello world","hwd").is_some());
        assert!(fuzzy_positions("hello world","hzz").is_none());
    }
    #[test] fn extracts_multiple_code_blocks() {
        assert_eq!(extract_code("```rust\nfn main() {}\n```\n~~~bash\necho hi\n~~~").len(),2);
    }
}
