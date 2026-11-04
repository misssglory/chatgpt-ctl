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

/// Lightweight syntax coloring for common code panes; fuzzy match positions
/// remain the highest priority visual cue. No new lexer dependencies needed.
fn syntax_line(source: &str, lang: &str, query: &str, max_chars: usize) -> Line<'static> {
    let chars: Vec<char> = source.chars().collect();
    let matches = fuzzy_positions(source, query).map(|(_,p)|p).unwrap_or_default();
    let first = matches.first().copied().unwrap_or(0);
    let start = if first >= max_chars { first.saturating_sub(max_chars / 3) } else { 0 };
    let end = chars.len().min(start + max_chars);
    let rust = matches!(lang, "rust" | "rs");
    let shell = matches!(lang, "bash" | "sh" | "shell" | "zsh" | "nix");
    let python = matches!(lang, "python" | "py");
    let js = matches!(lang, "javascript" | "js" | "typescript" | "ts" | "tsx" | "jsx");
    let keywords: &[&str] = if rust { &[
        "fn","let","mut","pub","use","impl","struct","enum","match","if","else","for","while","loop","return","async","await","self","Self","trait","mod","const","static","true","false","Some","None","Ok","Err","where","in","move","ref"]
    } else if shell { &["if","then","fi","for","while","do","done","case","esac","function","export","local","return","in","source","echo","sudo"]
    } else if python { &["def","class","import","from","if","elif","else","for","while","return","async","await","with","as","try","except","None","True","False","lambda","yield","in"]
    } else if js { &["const","let","var","function","class","return","if","else","for","while","await","async","import","export","from","true","false","null","undefined","new","this"]
    } else { &[] };
    let mut spans = Vec::new();
    if start > 0 { spans.push(Span::raw("…")); }
    let mut i = start;
    while i < end {
        let c=chars[i];
        let comment = c == '#' && (shell || python) || c == '/' && i+1 < chars.len() && chars[i+1] == '/' && (rust || js);
        if comment {
            let mut j=i;
            while j<end { j+=1; }
            for k in i..j {
                let style = if matches.contains(&k) {Style::default().fg(Color::Black).bg(Color::Yellow).add_modifier(Modifier::BOLD)}
                    else {Style::default().fg(Color::DarkGray)};
                spans.push(Span::styled(chars[k].to_string(),style));
            }
            i=j;
            continue;
        }
        if c == '\'' || c == '"' {
            let q=c; let mut j=i+1;let mut escaped=false;
            while j<end {if chars[j]==q && !escaped {j+=1;break;}if chars[j]=='\\' {escaped=!escaped;}else{escaped=false;}j+=1;}
            for k in i..j {
                let style=if matches.contains(&k){Style::default().fg(Color::Black).bg(Color::Yellow)}else{Style::default().fg(Color::Green)};
                spans.push(Span::styled(chars[k].to_string(),style));
            }
            i=j;continue;
        }
        if c.is_alphanumeric() || c=='_' {
            let mut j=i+1;
            while j<end && (chars[j].is_alphanumeric() || chars[j]=='_') {j+=1;}
            let token: String=chars[i..j].iter().collect();
            let foreground=if keywords.contains(&token.as_str()) {Color::Magenta}
                else if token.chars().next().is_some_and(|v|v.is_ascii_digit()){Color::Yellow}
                else if j<chars.len() && chars[j]=='(' {Color::Cyan}
                else {Color::Reset};
            for k in i..j {
                let style=if matches.contains(&k){Style::default().fg(Color::Black).bg(Color::Yellow).add_modifier(Modifier::BOLD)}
                    else {Style::default().fg(foreground)};
                spans.push(Span::styled(chars[k].to_string(),style));
            }
            i=j;continue;
        }
        let style=if matches.contains(&i){Style::default().fg(Color::Black).bg(Color::Yellow).add_modifier(Modifier::BOLD)}
            else{Style::default()};
        spans.push(Span::styled(c.to_string(),style));i+=1;
    }
    if end<chars.len(){spans.push(Span::raw("…"));}
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
    cursor: usize, // Unicode-character index within query
    search_history: Vec<String>,
    history_index: Option<usize>,
    history_draft: String,
    viewer: bool,
    viewer_scroll: usize,
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
    fn set_query(&mut self, value: String) {
        self.query = value;
        self.cursor = self.query.chars().count();
        self.index = 0;
    }
    fn insert_query(&mut self, c: char) {
        let byte = self.query.char_indices().nth(self.cursor).map(|(i,_)|i).unwrap_or(self.query.len());
        self.query.insert(byte,c);
        self.cursor += 1;
        self.index = 0;
        self.history_index = None;
    }
    fn erase_before_cursor(&mut self) {
        if self.cursor == 0 { return; }
        let end = self.query.char_indices().nth(self.cursor).map(|(i,_)|i).unwrap_or(self.query.len());
        let start = self.query.char_indices().nth(self.cursor-1).map(|(i,_)|i).unwrap_or(0);
        self.query.replace_range(start..end, "");
        self.cursor -= 1;
        self.index = 0;
        self.history_index = None;
    }
    fn erase_at_cursor(&mut self) {
        let Some((start,_)) = self.query.char_indices().nth(self.cursor) else {return};
        let end = self.query.char_indices().nth(self.cursor+1).map(|(i,_)|i).unwrap_or(self.query.len());
        self.query.replace_range(start..end, "");
        self.index = 0;
        self.history_index = None;
    }
    fn submit_search(&mut self) {
        if !self.query.trim().is_empty() && self.search_history.last() != Some(&self.query) {
            self.search_history.push(self.query.clone());
        }
        self.searching = false;
        self.history_index = None;
    }
    fn previous_query(&mut self) {
        if self.search_history.is_empty() {return;}
        let next = match self.history_index {
            None => {self.history_draft=self.query.clone();self.search_history.len()-1},
            Some(0) => 0,
            Some(n) => n-1,
        };
        self.history_index=Some(next);
        self.set_query(self.search_history[next].clone());
    }
    fn next_query(&mut self) {
        if let Some(n) = self.history_index {
            if n+1 < self.search_history.len() {
                self.history_index=Some(n+1);
                self.set_query(self.search_history[n+1].clone());
            } else {
                self.history_index=None;
                self.set_query(self.history_draft.clone());
            }
        }
    }
    fn selected_turn(&self) -> Option<&Turn> {
        if self.tab != Tab::Questions {return None;}
        filtered_questions(&self.questions,&self.query).get(self.index).map(|&i|&self.questions[i])
    }
    fn selected_code(&self) -> Option<&CodeItem> {
        if self.tab != Tab::Code {return None;}
        filtered_code(&self.code,&self.query).get(self.index).map(|&i|&self.code[i])
    }
}

fn viewer_lines(m: &Model) -> Vec<Line<'static>> {
    let mut lines=Vec::new();
    if let Some(t)=m.selected_turn() {
        lines.push(Line::styled(format!("USER · sequence {} · {}",t.sequence,t.question_id),Style::default().fg(Color::Cyan).add_modifier(Modifier::BOLD)));
        for line in t.question.lines() {lines.push(emphasis(line,&m.query,usize::MAX / 2));}
        lines.push(Line::raw(""));
        lines.push(Line::styled(format!("ASSISTANT · {}",t.answer_id.map(|v|v.to_string()).unwrap_or_else(||"no answer indexed".into())),Style::default().fg(Color::Green).add_modifier(Modifier::BOLD)));
        for line in t.answers.lines() {
            // Preserve code layout while retaining fuzzy match highlighting.
            lines.push(emphasis(line,&m.query,usize::MAX / 2));
        }
    } else if let Some(c)=m.selected_code() {
        lines.push(Line::styled(format!("{} · block {} · sequence {} · {}",c.language,c.number+1,c.sequence,c.source_id),Style::default().fg(Color::Cyan).add_modifier(Modifier::BOLD)));
        lines.push(Line::styled(format!("Q: {}",c.question.lines().next().unwrap_or("")),Style::default().fg(Color::Gray)));
        lines.push(Line::raw(""));
        for (n,line) in c.body.lines().enumerate() {
            let mut spans=vec![Span::styled(format!("{:>4} │ ",n+1),Style::default().fg(Color::DarkGray))];
            spans.extend(syntax_line(line,&c.language,&m.query,usize::MAX/2).spans);
            lines.push(Line::from(spans));
        }
    }
    lines
}

fn draw_viewer(frame: &mut ratatui::Frame, m: &Model) {
    let parts=Layout::default().direction(Direction::Vertical)
        .constraints([Constraint::Length(2),Constraint::Min(3),Constraint::Length(2)]).split(frame.area());
    let title=if m.tab==Tab::Questions {"Question & answer"} else {"Code block"};
    frame.render_widget(Paragraph::new(format!(" {} · {}",m.title,title)).style(Style::default().fg(Color::Cyan).add_modifier(Modifier::BOLD)),parts[0]);
    let content=viewer_lines(m);
    let max_scroll=content.len().saturating_sub(parts[1].height.saturating_sub(2) as usize);
    let scroll=m.viewer_scroll.min(max_scroll);
    frame.render_widget(Paragraph::new(content).block(Block::default().borders(Borders::ALL).title(title))
        .scroll((scroll.min(u16::MAX as usize) as u16,0)),parts[1]);
    frame.render_widget(Paragraph::new(format!("↑↓/jk scroll   PgUp/PgDn page   Home/End   Esc/Enter back   b browser jump   {}",m.status))
        .style(Style::default().fg(Color::Gray)),parts[2]);
}

fn draw(frame: &mut ratatui::Frame, m: &Model) {
    if m.viewer {draw_viewer(frame,m);return;}
    let parts = Layout::default().direction(Direction::Vertical)
        .constraints([Constraint::Length(2),Constraint::Length(3),Constraint::Min(3),Constraint::Length(2)])
        .split(frame.area());
    let tab_title = format!(" {}   [1] Questions ({})   [2] Code blocks ({}) ", m.title, m.questions.len(), m.code.len());
    frame.render_widget(Paragraph::new(tab_title).style(Style::default().fg(Color::Cyan).add_modifier(Modifier::BOLD)),parts[0]);
    let prompt = if m.searching { "Search (type, Esc to stop): " } else { "Filter (/ to edit): " };
    let visible_width=parts[1].width.saturating_sub(2) as usize;
    let prefix_width=prompt.chars().count();
    let available=visible_width.saturating_sub(prefix_width).max(1);
    let query_chars:Vec<char>=m.query.chars().collect();
    let scroll=if m.searching {m.cursor.saturating_sub(available.saturating_sub(1))} else {0};
    let shown:String=query_chars.iter().skip(scroll).take(available).collect();
    let field_text=format!("{prompt}{shown}");
    frame.render_widget(Paragraph::new(field_text)
        .block(Block::default().borders(Borders::ALL).title("Fuzzy search: questions + answers / code")), parts[1]);
    if m.searching && visible_width>0 {
        let x=(prefix_width+m.cursor.saturating_sub(scroll)).min(visible_width-1);
        frame.set_cursor_position((parts[1].x.saturating_add(1).saturating_add(x as u16),parts[1].y+1));
    }
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
                lines.push(syntax_line(line,&b.language,&m.query,display_width));
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
    frame.render_widget(Paragraph::new(format!("↑↓/jk select   Enter view in TUI   b browser jump   Tab switch   / filter   Esc clear   q quit   {}",m.status))
        .wrap(Wrap{trim:true}).style(Style::default().fg(Color::Gray)),parts[3]);
}

fn browser_jump(m: &mut Model, chat_id: Uuid) {
    if let Some(message_id)=m.selected() {
        let payload=serde_json::json!({"chat_id":chat_id.to_string(),"message_id":message_id.to_string()}).to_string();
        m.status=match watcher_request("POST","/jump-message",Some(&payload)) {
            Ok(_) => format!("opened {message_id} in browser"),
            Err(err) => format!("browser jump failed: {err:#}"),
        };
    }
}

pub(crate) async fn run(client: &Client, chat_id: Uuid, title: String) -> Result<()> {
    let messages=fetch_messages(client,chat_id,false,0).await?;
    let (questions,code)=build_items(&messages);
    if questions.is_empty() && code.is_empty() { anyhow::bail!("no persisted messages for chat {chat_id}"); }
    let mut m=Model { tab:Tab::Questions,query:String::new(),searching:false,cursor:0,
        search_history:Vec::new(),history_index:None,history_draft:String::new(),viewer:false,viewer_scroll:0,
        index:0,status:String::new(),questions,code,title };
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
                    KeyCode::Esc => {m.searching=false;m.history_index=None;},
                    KeyCode::Enter => m.submit_search(),
                    KeyCode::Left => m.cursor=m.cursor.saturating_sub(1),
                    KeyCode::Right => m.cursor=(m.cursor+1).min(m.query.chars().count()),
                    KeyCode::Home => m.cursor=0,
                    KeyCode::End => m.cursor=m.query.chars().count(),
                    KeyCode::Up => m.previous_query(),
                    KeyCode::Down => m.next_query(),
                    KeyCode::Backspace => m.erase_before_cursor(),
                    KeyCode::Delete => m.erase_at_cursor(),
                    KeyCode::Char(c) => m.insert_query(c),
                    _ => {}
                }
                continue;
            }
            if m.viewer {
                match key.code {
                    KeyCode::Esc | KeyCode::Enter => {m.viewer=false;m.viewer_scroll=0;},
                    KeyCode::Down | KeyCode::Char('j') => m.viewer_scroll=m.viewer_scroll.saturating_add(1),
                    KeyCode::Up | KeyCode::Char('k') => m.viewer_scroll=m.viewer_scroll.saturating_sub(1),
                    KeyCode::PageDown => m.viewer_scroll=m.viewer_scroll.saturating_add(20),
                    KeyCode::PageUp => m.viewer_scroll=m.viewer_scroll.saturating_sub(20),
                    KeyCode::Home => m.viewer_scroll=0,
                    KeyCode::End => m.viewer_scroll=viewer_lines(&m).len(),
                    KeyCode::Char('b') | KeyCode::Char('o') => browser_jump(&mut m,chat_id),
                    _ => {}
                }
                continue;
            }
            match key.code {
                KeyCode::Char('q') | KeyCode::Esc => {if m.query.is_empty(){break;}else{m.set_query(String::new());}},
                KeyCode::Char('/') => {m.searching=true;m.cursor=m.query.chars().count();},
                KeyCode::Tab => m.change_tab(),
                KeyCode::Char('1') => {m.tab=Tab::Questions;m.index=0;},
                KeyCode::Char('2') => {m.tab=Tab::Code;m.index=0;},
                KeyCode::Down | KeyCode::Char('j') => m.index=(m.index+1).min(m.count().saturating_sub(1)),
                KeyCode::Up | KeyCode::Char('k') => m.index=m.index.saturating_sub(1),
                KeyCode::PageDown => m.index=(m.index+10).min(m.count().saturating_sub(1)),
                KeyCode::PageUp => m.index=m.index.saturating_sub(10),
                KeyCode::Home => m.index=0,
                KeyCode::End => m.index=m.count().saturating_sub(1),
                KeyCode::Enter => {if m.selected().is_some(){m.viewer=true;m.viewer_scroll=0;}},
                KeyCode::Char('b') | KeyCode::Char('o') => browser_jump(&mut m,chat_id),
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
    #[test] fn syntax_rust_and_bash() {
        assert!(!syntax_line("fn main() { println!(\"ok\"); }", "rust", "main", 90).spans.is_empty());
        assert!(!syntax_line("echo hello # comment", "bash", "echo", 90).spans.is_empty());
    }
    #[test] fn search_history_and_unicode_cursor() {
        let mut m=Model {tab:Tab::Questions,query:String::new(),searching:true,cursor:0,
            search_history:Vec::new(),history_index:None,history_draft:String::new(),viewer:false,viewer_scroll:0,
            index:0,status:String::new(),questions:Vec::new(),code:Vec::new(),title:String::new()};
        m.insert_query('Ж');m.insert_query('x');m.cursor=1;m.insert_query('и');
        assert_eq!(m.query,"Жиx");m.erase_before_cursor();assert_eq!(m.query,"Жx");
        m.submit_search();m.set_query("second".into());m.submit_search();
        m.set_query("draft".into());m.previous_query();assert_eq!(m.query,"second");
        m.previous_query();assert_eq!(m.query,"Жx");
        m.next_query();assert_eq!(m.query,"second");m.next_query();assert_eq!(m.query,"draft");
    }
    #[test] fn extracts_multiple_code_blocks() {
        assert_eq!(extract_code("```rust\nfn main() {}\n```\n~~~bash\necho hi\n~~~").len(),2);
    }
}
