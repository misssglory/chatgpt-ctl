//! chatgpt-ctl — browse ChatGPT history persisted by chatgpt-history-watcher.
//!
//! Autocompletion:
//!   - Shell: `chatgpt-ctl completions bash|zsh|fish`  (static clap completions)
//!   - Interactive: `chatgpt-ctl history` with no args opens a rustyline prompt
//!     that completes chat titles / UUIDs loaded from PostgreSQL.

use anyhow::{Context, Result};
use chrono::{DateTime, Utc};
use clap::{CommandFactory, Parser, Subcommand, ValueEnum};
use clap_complete::{generate, Shell};
use rustyline::completion::{Completer, Pair};
use rustyline::error::ReadlineError;
use rustyline::highlight::Highlighter;
use rustyline::hint::Hinter;
use rustyline::validate::Validator;
use rustyline::{CompletionType, Config, Context as RlContext, Editor, Helper};
use std::borrow::Cow;
use std::io::{self, Read, Write};
use std::net::TcpStream;
use std::path::PathBuf;
use std::process::Command;
use tokio_postgres::{Client, NoTls};
use uuid::Uuid;

#[derive(Parser, Debug)]
#[command(name = "chatgpt-ctl", version, about = "Watch / query ChatGPT history from PostgreSQL")]
struct Cli {
    /// Postgres connection string (default: CHATGPT_DATABASE_URL or local chatgpt_history)
    #[arg(long, env = "CHATGPT_DATABASE_URL", global = true)]
    database_url: Option<String>,

    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand, Debug)]
enum Commands {
    /// List chats (most recently updated first)
    Chats {
        /// Max rows
        #[arg(short, long, default_value_t = 50)]
        limit: i64,
        /// Case-insensitive title substring filter
        #[arg(short, long)]
        query: Option<String>,
        /// Refresh all chats and titles from the live sidebar before listing
        #[arg(short, long)]
        refresh: bool,
    },

    /// Send text to the currently open chat, optionally with file attachments
    Send {
        /// Message text (quote text containing spaces)
        text: String,
        /// File to upload; repeat for multiple attachments
        #[arg(short = 'f', long = "file", value_name = "PATH")]
        files: Vec<PathBuf>,
    },

    /// Open a chat in the active watcher browser pane by UUID or title.
    ///
    /// With no CHAT argument, enters an interactive prompt with DB-backed
    /// autocomplete on chat titles and UUIDs.
    Open {
        /// Chat UUID, title substring, or "current"
        chat: Option<String>,
    },

    /// Show message history for a chat.
    ///
    /// With no CHAT argument, enters an interactive prompt with DB-backed
    /// autocomplete on chat titles and UUIDs.
    History {
        /// Chat UUID, title substring, or "current" (most recently updated chat)
        chat: Option<String>,
        /// Only completed messages
        #[arg(long, default_value_t = true)]
        completed_only: bool,
        /// Include incomplete / still-streaming rows
        #[arg(long, default_value_t = false)]
        all: bool,
        /// Max messages (0 = unlimited)
        #[arg(short, long, default_value_t = 0)]
        limit: i64,
        /// Print raw JSON instead of human text
        #[arg(long)]
        json: bool,
        /// Follow (poll) for new completed messages
        #[arg(short, long)]
        follow: bool,
        /// Follow poll interval in milliseconds
        #[arg(long, default_value_t = 1500)]
        interval_ms: u64,
    },

    /// Print one message by id
    Message {
        id: String,
        #[arg(long)]
        json: bool,
    },

    /// Emit shell completions for bash / zsh / fish / elvish / powershell
    Completions {
        shell: ShellKind,
    },
}

#[derive(Clone, Debug, ValueEnum)]
enum ShellKind {
    Bash,
    Elvish,
    Fish,
    Powershell,
    Zsh,
}

impl From<ShellKind> for Shell {
    fn from(s: ShellKind) -> Self {
        match s {
            ShellKind::Bash => Shell::Bash,
            ShellKind::Elvish => Shell::Elvish,
            ShellKind::Fish => Shell::Fish,
            ShellKind::Powershell => Shell::PowerShell,
            ShellKind::Zsh => Shell::Zsh,
        }
    }
}

fn default_database_url() -> String {
    std::env::var("CHATGPT_DATABASE_URL").unwrap_or_else(|_| {
        "postgres://chatgpt:chatgpt@127.0.0.1:5432/chatgpt_history".to_string()
    })
}

/// Browser commands stay in the optional watcher, keeping this Rust binary small.
fn run_watcher(args: &[String]) -> Result<()> {
    let script = std::env::var_os("CHATGPT_WATCHER")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("src/index.ts"));
    if !script.is_file() {
        anyhow::bail!(
            "watcher script not found at {}; run from the repository root or set CHATGPT_WATCHER=/path/to/src/index.ts",
            script.display()
        );
    }
    let bun = std::env::var_os("CHATGPT_BUN").unwrap_or_else(|| "bun".into());
    let status = Command::new(&bun)
        .arg(&script)
        .args(args)
        .status()
        .with_context(|| format!("run watcher with {:?}", bun))?;
    if !status.success() {
        anyhow::bail!("watcher command failed with {status}");
    }
    Ok(())
}

fn watcher_args(command: &str, values: &[String]) -> Vec<String> {
    std::iter::once(command.to_string())
        .chain(values.iter().cloned())
        .collect()
}

async fn connect(url: &str) -> Result<Client> {
    let (client, connection) = tokio_postgres::connect(url, NoTls)
        .await
        .with_context(|| format!("connect to {url}"))?;
    tokio::spawn(async move {
        if let Err(e) = connection.await {
            eprintln!("postgres connection error: {e}");
        }
    });
    Ok(client)
}

#[derive(Debug, Clone)]
struct ChatRow {
    id: Uuid,
    title: String,
    updated_at: Option<DateTime<Utc>>,
    message_count: i64,
}

async fn list_chats(client: &Client, limit: i64, query: Option<&str>) -> Result<Vec<ChatRow>> {
    let rows = if let Some(q) = query {
        let pattern = format!("%{}%", q);
        client
            .query(
                r#"
                SELECT c.id, c.title, c.updated_at,
                       (SELECT COUNT(*) FROM messages m WHERE m.chat_id = c.id) AS message_count
                FROM chats c
                WHERE c.title ILIKE $1 OR c.id::text ILIKE $1
                ORDER BY c.updated_at DESC NULLS LAST
                LIMIT $2
                "#,
                &[&pattern, &limit],
            )
            .await?
    } else {
        client
            .query(
                r#"
                SELECT c.id, c.title, c.updated_at,
                       (SELECT COUNT(*) FROM messages m WHERE m.chat_id = c.id) AS message_count
                FROM chats c
                ORDER BY c.updated_at DESC NULLS LAST
                LIMIT $1
                "#,
                &[&limit],
            )
            .await?
    };

    Ok(rows
        .into_iter()
        .map(|r| ChatRow {
            id: r.get(0),
            title: r.get(1),
            updated_at: r.get(2),
            message_count: r.get(3),
        })
        .collect())
}

async fn resolve_chat_id(client: &Client, spec: &str) -> Result<Uuid> {
    if spec.eq_ignore_ascii_case("current") || spec.is_empty() {
        let row = client
            .query_opt(
                "SELECT id FROM chats ORDER BY updated_at DESC NULLS LAST LIMIT 1",
                &[],
            )
            .await?
            .context("no chats in database — run the watcher first")?;
        return Ok(row.get(0));
    }

    if let Ok(u) = Uuid::parse_str(spec) {
        return Ok(u);
    }

    // Title / partial uuid match
    let pattern = format!("%{}%", spec);
    let rows = client
        .query(
            r#"
            SELECT id, title FROM chats
            WHERE title ILIKE $1 OR id::text ILIKE $1
            ORDER BY updated_at DESC NULLS LAST
            LIMIT 10
            "#,
            &[&pattern],
        )
        .await?;

    if rows.is_empty() {
        anyhow::bail!("no chat matching '{spec}'");
    }
    if rows.len() > 1 {
        eprintln!("multiple matches for '{spec}':");
        for r in &rows {
            let id: Uuid = r.get(0);
            let title: String = r.get(1);
            eprintln!("  {}  {}", id, title);
        }
        anyhow::bail!("refine the query (or pass a full UUID)");
    }
    Ok(rows[0].get(0))
}

#[derive(Debug)]
struct MsgRow {
    id: Uuid,
    role: String,
    content: String,
    sequence: i32,
    completed: bool,
    completed_at: Option<DateTime<Utc>>,
}

async fn fetch_messages(
    client: &Client,
    chat_id: Uuid,
    completed_only: bool,
    limit: i64,
) -> Result<Vec<MsgRow>> {
    let rows = if completed_only {
        if limit > 0 {
            client
                .query(
                    r#"
                    SELECT id, role, content, sequence, completed, completed_at
                    FROM messages
                    WHERE chat_id = $1 AND completed = true
                    ORDER BY sequence ASC, completed_at ASC NULLS LAST
                    LIMIT $2
                    "#,
                    &[&chat_id, &limit],
                )
                .await?
        } else {
            client
                .query(
                    r#"
                    SELECT id, role, content, sequence, completed, completed_at
                    FROM messages
                    WHERE chat_id = $1 AND completed = true
                    ORDER BY sequence ASC, completed_at ASC NULLS LAST
                    "#,
                    &[&chat_id],
                )
                .await?
        }
    } else if limit > 0 {
        client
            .query(
                r#"
                SELECT id, role, content, sequence, completed, completed_at
                FROM messages
                WHERE chat_id = $1
                ORDER BY sequence ASC
                LIMIT $2
                "#,
                &[&chat_id, &limit],
            )
            .await?
    } else {
        client
            .query(
                r#"
                SELECT id, role, content, sequence, completed, completed_at
                FROM messages
                WHERE chat_id = $1
                ORDER BY sequence ASC
                "#,
                &[&chat_id],
            )
            .await?
    };

    Ok(rows
        .into_iter()
        .map(|r| MsgRow {
            id: r.get(0),
            role: r.get(1),
            content: r.get(2),
            sequence: r.get(3),
            completed: r.get(4),
            completed_at: r.get(5),
        })
        .collect())
}

fn print_messages(msgs: &[MsgRow], json: bool) {
    if json {
        let v: Vec<_> = msgs
            .iter()
            .map(|m| {
                serde_json::json!({
                    "id": m.id,
                    "role": m.role,
                    "content": m.content,
                    "sequence": m.sequence,
                    "completed": m.completed,
                    "completed_at": m.completed_at,
                })
            })
            .collect();
        println!("{}", serde_json::to_string_pretty(&v).unwrap());
        return;
    }

    for m in msgs {
        let flag = if m.completed { "✓" } else { "…" };
        println!(
            "── {} [{}] seq={} {} ──",
            m.role.to_uppercase(),
            flag,
            m.sequence,
            m.id
        );
        println!("{}\n", m.content);
    }
}

// ---------------------------------------------------------------------------
// Interactive completer (titles + uuids from DB)
// ---------------------------------------------------------------------------

struct ChatHelper {
    candidates: Vec<(String, String)>, // (display, replacement)
}

impl Completer for ChatHelper {
    type Candidate = Pair;

    fn complete(
        &self,
        line: &str,
        pos: usize,
        _ctx: &RlContext<'_>,
    ) -> rustyline::Result<(usize, Vec<Pair>)> {
        let prefix = &line[..pos];
        let start = prefix.rfind(char::is_whitespace).map(|i| i + 1).unwrap_or(0);
        let word = &prefix[start..];
        let word_l = word.to_lowercase();

        let matches: Vec<Pair> = self
            .candidates
            .iter()
            .filter(|(disp, id)| {
                disp.to_lowercase().contains(&word_l) || id.to_lowercase().starts_with(&word_l)
            })
            .map(|(disp, id)| Pair {
                display: format!("{disp}  ({id})"),
                replacement: id.clone(),
            })
            .collect();

        Ok((start, matches))
    }
}

impl Hinter for ChatHelper {
    type Hint = String;
}
impl Highlighter for ChatHelper {}
impl Validator for ChatHelper {}
impl Helper for ChatHelper {}

async fn interactive_history(client: &Client, completed_only: bool, limit: i64, json: bool) -> Result<()> {
    let chats = list_chats(client, 1000, None).await?;
    if chats.is_empty() {
        anyhow::bail!("no chats in database — run `bun run watch` first");
    }

    let candidates: Vec<(String, String)> = chats
        .iter()
        .map(|c| (c.title.clone(), c.id.to_string()))
        .collect();

    let helper = ChatHelper { candidates };
    let config = Config::builder()
        .completion_type(CompletionType::List)
        .build();
    let mut rl = Editor::with_config(config)?;
    rl.set_helper(Some(helper));

    println!("Type a chat title or UUID (TAB to autocomplete from DB), or 'current':");
    let readline = rl.readline("history> ");
    match readline {
        Ok(line) => {
            let line = line.trim();
            if line.is_empty() {
                return Ok(());
            }
            let chat_id = resolve_chat_id(client, line).await?;
            let msgs = fetch_messages(client, chat_id, completed_only, limit).await?;
            print_messages(&msgs, json);
        }
        Err(ReadlineError::Interrupted) | Err(ReadlineError::Eof) => {}
        Err(e) => return Err(e.into()),
    }
    Ok(())
}

async fn interactive_open(client: &Client) -> Result<Uuid> {
    let chats = list_chats(client, 1000, None).await?;
    if chats.is_empty() {
        anyhow::bail!("no chats in database — run `chatgpt-ctl chats --refresh` first");
    }
    let candidates = chats
        .iter()
        .map(|c| (c.title.clone(), c.id.to_string()))
        .collect();
    let helper = ChatHelper { candidates };
    let config = Config::builder()
        .completion_type(CompletionType::List)
        .build();
    let mut rl = Editor::with_config(config)?;
    rl.set_helper(Some(helper));

    println!("Type a chat title or UUID (TAB to autocomplete), or 'current':");
    match rl.readline("open> ") {
        Ok(line) if !line.trim().is_empty() => resolve_chat_id(client, line.trim()).await,
        Ok(_) => anyhow::bail!("no chat selected"),
        Err(ReadlineError::Interrupted) | Err(ReadlineError::Eof) => {
            anyhow::bail!("no chat selected")
        }
        Err(e) => Err(e.into()),
    }
}

async fn follow_history(
    client: &Client,
    chat_id: Uuid,
    completed_only: bool,
    interval_ms: u64,
) -> Result<()> {
    use std::collections::HashSet;
    let mut seen: HashSet<Uuid> = HashSet::new();
    // seed
    let initial = fetch_messages(client, chat_id, completed_only, 0).await?;
    for m in &initial {
        seen.insert(m.id);
    }
    print_messages(&initial, false);
    println!("── following chat {chat_id} (Ctrl-C to stop) ──");

    loop {
        tokio::time::sleep(std::time::Duration::from_millis(interval_ms)).await;
        let msgs = fetch_messages(client, chat_id, completed_only, 0).await?;
        for m in msgs {
            if seen.insert(m.id) {
                print_messages(std::slice::from_ref(&m), false);
            } else if !completed_only {
                // content may still grow while incomplete — skip re-print for simplicity
            }
        }
    }
}


/// Ask the long-running Bun watcher to navigate its existing browser pane.
fn request_active_pane_open(chat_id: Uuid) -> Result<()> {
    let address = std::env::var("CHATGPT_CTL_ADDR")
        .unwrap_or_else(|_| "127.0.0.1:17381".to_string());
    let mut stream = TcpStream::connect(&address)
        .with_context(|| format!("connect to watcher control server at {address}; start `bun run watch` from the repository root"))?;
    stream.set_read_timeout(Some(std::time::Duration::from_secs(50)))?;
    let body = serde_json::json!({ "chat_id": chat_id }).to_string();
    write!(
        stream,
        "POST /open HTTP/1.1\r\nHost: {address}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        body.len(),
        body
    )?;
    let mut response = String::new();
    stream.read_to_string(&mut response)?;
    let status = response.lines().next().unwrap_or_default();
    if !status.contains(" 200 ") {
        let message = response.split("\r\n\r\n").nth(1).unwrap_or("watcher rejected open request");
        anyhow::bail!("watcher open failed ({status}): {message}");
    }
    println!("opened {chat_id} in the active ChatGPT pane");
    Ok(())
}

#[tokio::main]
async fn main() -> Result<()> {
    let cli = Cli::parse();
    let url = cli
        .database_url
        .clone()
        .unwrap_or_else(default_database_url);

    match cli.command {
        Commands::Completions { shell } => {
            let mut cmd = Cli::command();
            let shell: Shell = shell.into();
            generate(shell, &mut cmd, "chatgpt-ctl", &mut io::stdout());
            return Ok(());
        }
        Commands::Chats { limit, query, refresh } => {
            if refresh {
                run_watcher(&watcher_args("sync-chats", &["--quiet".to_string()]))?;
            }
            let client = connect(&url).await?;
            let chats = list_chats(&client, limit, query.as_deref()).await?;
            for c in chats {
                let ts = c
                    .updated_at
                    .map(|t| t.format("%Y-%m-%d %H:%M").to_string())
                    .unwrap_or_else(|| "-".into());
                println!(
                    "{}\t{:>4} msgs\t{}\t{}",
                    c.id, c.message_count, ts, c.title
                );
            }
        }
        Commands::Send { text, files } => {
            let mut values = vec![text];
            for file in files {
                let file = file
                    .canonicalize()
                    .with_context(|| format!("access attachment {}", file.display()))?;
                values.push("--file".to_string());
                values.push(file.to_string_lossy().into_owned());
            }
            run_watcher(&watcher_args("send", &values))?;
        }
        Commands::Open { chat } => {
            let client = connect(&url).await?;
            let chat_id = match chat {
                Some(spec) => resolve_chat_id(&client, &spec).await?,
                None => interactive_open(&client).await?,
            };
            request_active_pane_open(chat_id)?;
        }
        Commands::History {
            chat,
            completed_only,
            all,
            limit,
            json,
            follow,
            interval_ms,
        } => {
            let client = connect(&url).await?;
            let completed_only = if all { false } else { completed_only };

            match chat {
                None => {
                    interactive_history(&client, completed_only, limit, json).await?;
                }
                Some(spec) => {
                    let chat_id = resolve_chat_id(&client, &spec).await?;
                    if follow {
                        follow_history(&client, chat_id, completed_only, interval_ms).await?;
                    } else {
                        let msgs = fetch_messages(&client, chat_id, completed_only, limit).await?;
                        print_messages(&msgs, json);
                    }
                }
            }
        }
        Commands::Message { id, json } => {
            let client = connect(&url).await?;
            let uid = Uuid::parse_str(&id).context("message id must be a UUID")?;
            let row = client
                .query_opt(
                    r#"
                    SELECT id, role, content, sequence, completed, completed_at
                    FROM messages WHERE id = $1
                    "#,
                    &[&uid],
                )
                .await?
                .context("message not found")?;
            let msg = MsgRow {
                id: row.get(0),
                role: row.get(1),
                content: row.get(2),
                sequence: row.get(3),
                completed: row.get(4),
                completed_at: row.get(5),
            };
            print_messages(&[msg], json);
        }
    }

    Ok(())
}
