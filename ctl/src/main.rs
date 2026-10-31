//! chatgpt-ctl — browse ChatGPT history persisted by chatgpt-history-watcher.
//!
//! Autocompletion:
//!   - Shell: `chatgpt-ctl completions bash|zsh|fish` (clap command/option completions)
//!   - Dynamic chat candidates: hidden `__complete-chat` helper for shell integrations
//!   - Interactive: `open` / `history` without an argument complete DB chat titles / UUIDs.

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
        /// Max rows (0 = all chats across all browser profiles)
        #[arg(short, long, default_value_t = 0)]
        limit: i64,
        /// Case-insensitive title substring filter
        #[arg(short, long)]
        query: Option<String>,
        /// Refresh all chats and titles from the live sidebar before listing
        #[arg(short, long)]
        refresh: bool,
    },

    /// Send text to the focused chat, or target a chat explicitly with --chat
    Send {
        /// Optional message text (quote text containing spaces); may be omitted when attaching files
        text: Option<String>,
        /// Target chat UUID or title substring (opens a pane if necessary)
        #[arg(short = 'c', long = "chat", value_name = "CHAT", conflicts_with = "new_chat")]
        chat: Option<String>,
        /// Create a separate blank chat, send the first message, and return its new conversation UUID
        #[arg(long = "new-chat", alias = "new", conflicts_with = "chat")]
        new_chat: bool,
        /// File to upload; repeat for multiple attachments
        #[arg(short = 'f', long = "file", value_name = "PATH", value_hint = clap::ValueHint::FilePath)]
        files: Vec<PathBuf>,
        /// Attach files and fill the composer, but do not submit the message
        #[arg(long, alias = "no-send", conflicts_with = "new_chat")]
        draft: bool,
    },

    /// Open a chat in its own watcher browser pane (reuse its pane if already open).
    ///
    /// With no CHAT argument, opens fzf to search chats by index, ID, or title.
    Open {
        /// Chat UUID, title substring, or "current"
        chat: Option<String>,
    },

    /// Close an opened chat pane by UUID, unique title substring, or 0-based chats index.
    Close {
        /// Chat UUID, title substring, or 0-based index from `chatgpt-ctl chats`
        chat: String,
    },

    /// Open a blank new chat in its own watcher browser pane (URL has no conversation UUID).
    NewChat,

    /// Download the newest ZIP attachment from virtual focus or a selected chat.
    DownloadLastZip {
        /// Destination directory for the ZIP file (default: ./var/downloads)
        #[arg(value_name = "DIR", value_hint = clap::ValueHint::DirPath)]
        directory: Option<PathBuf>,
        /// Chat UUID, title substring, or 0-based index; defaults to virtual focus
        #[arg(short = 'c', long = "chat", value_name = "CHAT")]
        chat: Option<String>,
        /// Extract the downloaded ZIP into this directory (keeps the ZIP file)
        #[arg(long = "extract-to", alias = "unzip-to", value_name = "DIR", value_hint = clap::ValueHint::DirPath)]
        extract_to: Option<PathBuf>,
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

    /// Enable or disable automatic clicking of a Retry button at the end of a chat
    Retry {
        /// Chat UUID or unique title substring
        chat: String,
        /// Whether automatic retry clicking is enabled
        mode: RetryMode,
    },

    /// Manage per-conversation ZIP/build automation hooks (stored in PostgreSQL)
    Hook {
        #[command(subcommand)]
        action: HookAction,
    },

    /// Internal helper used by shell completion snippets to suggest chat titles and UUIDs
    #[command(name = "__complete-chat", hide = true)]
    CompleteChat {
        /// Current word prefix
        prefix: Option<String>,
    },

    /// Emit shell completions for bash / zsh / fish / elvish / powershell
    Completions {
        shell: ShellKind,
    },
}

#[derive(Subcommand, Debug)]
enum HookAction {
    /// Create or replace a hook for a chat
    Set {
        /// Chat UUID or unique title substring
        chat: String,
        /// Project root / Git working tree (stored as an absolute path)
        #[arg(long, value_name = "DIR", value_hint = clap::ValueHint::DirPath)]
        folder: PathBuf,
        /// Build directory below --folder (default: .)
        #[arg(long, default_value = ".", value_name = "DIR", value_hint = clap::ValueHint::DirPath)]
        child_folder: String,
        /// Build command executed from --child-folder; use `none` to skip building (default: wcc build)
        #[arg(long, default_value = "wcc build")]
        build_command: String,
        /// Run the build command inside `nix develop <build-dir>`
        #[arg(long)]
        nix_flake: bool,
        /// Clipboard executable (default: wl-paste)
        #[arg(long, default_value = "wl-paste")]
        clipboard_command: String,
        /// Extra argument to the clipboard executable (repeatable; default: -n)
        #[arg(long = "clipboard-arg")]
        clipboard_args: Vec<String>,
    },
    /// List configured hooks
    List,
    /// Show one chat's hook
    Show { chat: String },
    /// Manually run a hook using the newest ZIP attachment in the selected or virtual-focus conversation
    #[command(alias = "trigger")]
    Run {
        /// Optional chat UUID or title; defaults to the virtual-focus conversation
        chat: Option<String>,
    },
    /// Enable a hook
    Enable { chat: String },
    /// Disable a hook without deleting it
    Disable { chat: String },
    /// Remove a hook
    Remove { chat: String },
}

#[derive(Clone, Debug, ValueEnum)]
enum RetryMode {
    Enable,
    Disable,
}

#[derive(Clone, Copy, Debug, ValueEnum)]
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

/// Emit clap's complete static zsh parser with small additions for invocation
/// through a path (`./target/release/chatgpt-ctl`) and database-backed chat IDs.
/// The clap-generated body remains responsible for every command and option.
fn zsh_completion_text(cmd: &mut clap::Command) -> Result<String> {
    const ZSH_DYNAMIC_CHAT: &str = r#"
# Resolve the executable as it was invoked. This matters when the user runs
# ./ctl/target/release/chatgpt-ctl rather than a PATH-installed command.
local _ctl_completion_bin="${words[1]}"
if [[ ! -x "$_ctl_completion_bin" ]]; then
  _ctl_completion_bin="${commands[chatgpt-ctl]:-chatgpt-ctl}"
fi

# Supply UUID candidates (with titles as descriptions) for chat-taking args.
local _ctl_wants_chat=0
case "${words[2]:-}" in
  open|close|history|retry)
    (( CURRENT == 3 )) && _ctl_wants_chat=1
    ;;
  send|download-last-zip)
    if (( CURRENT > 2 )) && [[ "${words[CURRENT-1]:-}" == (-c|--chat) ]]; then
      _ctl_wants_chat=1
    fi
    ;;
  hook)
    case "${words[3]:-}" in
      set|show|run|trigger|enable|disable|remove)
        (( CURRENT == 4 )) && _ctl_wants_chat=1
        ;;
    esac
    ;;
esac

if (( _ctl_wants_chat )); then
  local -a _ctl_chat_ids _ctl_chat_descriptions
  local _ctl_chat_id _ctl_chat_title
  while IFS=$'\t' read -r _ctl_chat_id _ctl_chat_title; do
    [[ -n "$_ctl_chat_id" ]] || continue
    _ctl_chat_ids+=("$_ctl_chat_id")
    _ctl_chat_descriptions+=("$_ctl_chat_title")
  done < <("$_ctl_completion_bin" __complete-chat "$PREFIX" 2>/dev/null)
  if (( ${#_ctl_chat_ids[@]} > 0 )); then
    compadd -Q -d _ctl_chat_descriptions -- "${_ctl_chat_ids[@]}"
    return
  fi
fi
"#;

    let mut generated = Vec::new();
    generate(Shell::Zsh, cmd, "chatgpt-ctl", &mut generated);
    let generated = String::from_utf8(generated)
        .context("clap generated non-UTF8 zsh completion output")?;
    let (header, body) = generated
        .split_once('\n')
        .context("clap zsh completion did not contain a #compdef header")?;
    if !header.starts_with("#compdef") {
        anyhow::bail!("unexpected clap zsh completion header: {header}");
    }

    // zsh's #compdef -p mapping applies to both the command basename and any
    // executable path ending in chatgpt-ctl. `ctl` is included as a short alias.
    Ok(format!("#compdef -p '*chatgpt-ctl' ctl\n{ZSH_DYNAMIC_CHAT}{body}"))
}

fn print_zsh_completions(cmd: &mut clap::Command) -> Result<()> {
    print!("{}", zsh_completion_text(cmd)?);
    Ok(())
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
    browser_name: String,
    updated_at: Option<DateTime<Utc>>,
    message_count: i64,
    /// Zero-based position in the complete, unfiltered combined chat ordering.
    global_index: i64,
}

async fn ensure_browser_map_table(client: &Client) -> Result<()> {
    client.execute(
        r#"CREATE TABLE IF NOT EXISTS chatgpt_watcher_chat_browsers (
             chat_id uuid PRIMARY KEY REFERENCES chats(id) ON DELETE CASCADE,
             browser_name text NOT NULL DEFAULT 'default',
             updated_at timestamptz NOT NULL DEFAULT now()
           )"#,
        &[],
    ).await?;
    Ok(())
}

async fn list_chats(client: &Client, limit: i64, query: Option<&str>) -> Result<Vec<ChatRow>> {
    ensure_browser_map_table(client).await?;
    let rows = if let Some(q) = query {
        let pattern = format!("%{}%", q);
        client
            .query(
                r#"
                WITH ranked_chats AS (
                    SELECT c.id, c.title, COALESCE(b.browser_name, 'default') AS browser_name,
                           c.updated_at,
                           (SELECT COUNT(*) FROM messages m WHERE m.chat_id = c.id) AS message_count,
                           (row_number() OVER (ORDER BY c.updated_at DESC NULLS LAST, c.id DESC) - 1) AS global_index
                    FROM chats c
                    LEFT JOIN chatgpt_watcher_chat_browsers b ON b.chat_id = c.id
                )
                SELECT id, title, browser_name, updated_at, message_count, global_index
                FROM ranked_chats
                WHERE title ILIKE $1 OR id::text ILIKE $1
                ORDER BY global_index
                LIMIT NULLIF($2::bigint, 0::bigint)
                "#,
                &[&pattern, &limit],
            )
            .await?
    } else {
        client
            .query(
                r#"
                WITH ranked_chats AS (
                    SELECT c.id, c.title, COALESCE(b.browser_name, 'default') AS browser_name,
                           c.updated_at,
                           (SELECT COUNT(*) FROM messages m WHERE m.chat_id = c.id) AS message_count,
                           (row_number() OVER (ORDER BY c.updated_at DESC NULLS LAST, c.id DESC) - 1) AS global_index
                    FROM chats c
                    LEFT JOIN chatgpt_watcher_chat_browsers b ON b.chat_id = c.id
                )
                SELECT id, title, browser_name, updated_at, message_count, global_index
                FROM ranked_chats
                ORDER BY global_index
                LIMIT NULLIF($1::bigint, 0::bigint)
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
            browser_name: r.get(2),
            updated_at: r.get(3),
            message_count: r.get(4),
            global_index: r.get(5),
        })
        .collect())
}

async fn resolve_chat_id(client: &Client, spec: &str) -> Result<Uuid> {
    ensure_browser_map_table(client).await?;
    if spec.eq_ignore_ascii_case("current") || spec.is_empty() {
        let row = client
            .query_opt(
                "SELECT id FROM chats ORDER BY updated_at DESC NULLS LAST, id DESC LIMIT 1",
                &[],
            )
            .await?
            .context("no chats in database — run the watcher first")?;
        return Ok(row.get(0));
    }

    if let Ok(u) = Uuid::parse_str(spec) {
        return Ok(u);
    }

    // Numeric selectors are zero-based indices in the unified `chats` listing.
    if spec.chars().all(|ch| ch.is_ascii_digit()) {
        let index: i64 = spec.parse().context("chat index is too large")?;
        let row = client.query_opt(
            "SELECT id FROM chats ORDER BY updated_at DESC NULLS LAST, id DESC LIMIT 1 OFFSET $1",
            &[&index],
        ).await?.with_context(|| format!("no chat at 0-based index {index}; run `chatgpt-ctl chats` to inspect the list"))?;
        return Ok(row.get(0));
    }

    // Title / partial uuid match
    let pattern = format!("%{}%", spec);
    let rows = client
        .query(
            r#"
            SELECT c.id, c.title, COALESCE(b.browser_name, 'default')
            FROM chats c LEFT JOIN chatgpt_watcher_chat_browsers b ON b.chat_id = c.id
            WHERE c.title ILIKE $1 OR c.id::text ILIKE $1
            ORDER BY c.updated_at DESC NULLS LAST, c.id DESC
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
            let browser_name: String = r.get(2);
            eprintln!("  [{}] {}  {}", browser_name, id, title);
        }
        anyhow::bail!("refine the query (or pass a full UUID)");
    }
    Ok(rows[0].get(0))
}

async fn ensure_retry_table(client: &Client) -> Result<()> {
    client.execute(
        r#"CREATE TABLE IF NOT EXISTS chat_retry_settings (
             chat_id uuid PRIMARY KEY REFERENCES chats(id) ON DELETE CASCADE,
             enabled boolean NOT NULL DEFAULT false,
             updated_at timestamptz NOT NULL DEFAULT now()
           )"#,
        &[],
    ).await?;
    Ok(())
}

async fn set_retry_setting(client: &Client, chat: &str, mode: RetryMode) -> Result<()> {
    ensure_retry_table(client).await?;
    let id = resolve_chat_id(client, chat).await?;
    let enabled = matches!(mode, RetryMode::Enable);
    client.execute(
        r#"INSERT INTO chat_retry_settings (chat_id, enabled, updated_at)
           VALUES ($1, $2, now())
           ON CONFLICT (chat_id) DO UPDATE SET enabled=EXCLUDED.enabled, updated_at=now()"#,
        &[&id, &enabled],
    ).await?;
    println!("automatic Retry clicking {} for {id}", if enabled { "enabled" } else { "disabled" });
    Ok(())
}

async fn ensure_hook_table(client: &Client) -> Result<()> {
    client.execute(
        r#"
        CREATE TABLE IF NOT EXISTS chat_hooks (
          chat_id uuid PRIMARY KEY REFERENCES chats(id) ON DELETE CASCADE,
          folder text NOT NULL,
          child_folder text NOT NULL DEFAULT '.',
          nix_flake boolean NOT NULL DEFAULT false,
          clipboard_command jsonb NOT NULL DEFAULT '["wl-paste", "-n"]'::jsonb,
          build_command text DEFAULT 'wcc build',
          enabled boolean NOT NULL DEFAULT true,
          updated_at timestamptz NOT NULL DEFAULT now()
        )
        "#,
        &[],
    ).await?;
    // Additive migration for databases created by older watcher versions.
    client.execute("ALTER TABLE chat_hooks ADD COLUMN IF NOT EXISTS build_command text DEFAULT 'wcc build'", &[]).await?;
    Ok(())
}

async fn complete_chat_values(client: &Client, prefix: &str) -> Result<()> {
    let pattern = format!("%{}%", prefix);
    let rows = client.query(
        "SELECT id, title FROM chats WHERE title ILIKE $1 OR id::text ILIKE $1 ORDER BY updated_at DESC NULLS LAST LIMIT 30",
        &[&pattern],
    ).await?;
    for row in rows {
        let id: Uuid = row.get(0);
        let title: String = row.get(1);
        println!("{}\t{}", id, title.replace('\n', " " ).replace('\r', " " ).replace('\t', " " ));
    }
    Ok(())
}


async fn run_hook_request(chat: Option<String>, database_url: &str) -> Result<()> {
    // Only explicit selectors need a CLI-side database lookup. For the default
    // virtual-focus target, the watcher already owns the database connection.
    let requested_id = if let Some(spec) = chat {
        let client = connect(database_url).await?;
        Some(resolve_chat_id(&client, &spec).await?)
    } else {
        None
    };
    let body = match requested_id.as_ref() {
        Some(id) => serde_json::json!({ "chat_id": id }).to_string(),
        None => "{}".to_string(),
    };
    let response = watcher_request("POST", "/hook/run", Some(&body))
        .context("could not trigger hook; is `bun run watch` running?")?;
    let value: serde_json::Value = serde_json::from_str(&response)?;
    let response_id = value.get("chat_id").and_then(|v| v.as_str()).map(str::to_owned);
    let id = response_id.or_else(|| requested_id.as_ref().map(ToString::to_string))
        .context("watcher response did not include the hook chat UUID")?;
    if let Some(path) = value.get("archive").and_then(|v| v.as_str()) {
        println!("hook completed for {id}: {path}");
    } else {
        println!("hook completed for {id}");
    }
    Ok(())
}

async fn run_hook_action(client: &Client, action: HookAction) -> Result<()> {
    ensure_hook_table(client).await?;
    match action {
        HookAction::Set { chat, folder, child_folder, build_command, nix_flake, clipboard_command, clipboard_args } => {
            let id = resolve_chat_id(client, &chat).await?;
            let folder = folder.canonicalize().with_context(|| format!("resolve hook folder {}", folder.display()))?;
            if !folder.is_dir() { anyhow::bail!("hook folder is not a directory: {}", folder.display()); }
            let mut command = vec![clipboard_command];
            if clipboard_args.is_empty() {
                if command[0] == "wl-paste" { command.push("-n".into()); }
            } else {
                command.extend(clipboard_args);
            }
            let command_json = serde_json::to_value(command)?;
            let build_command = if build_command.trim().eq_ignore_ascii_case("none") { None } else { Some(build_command.trim().to_string()) };
            let folder_text = folder.to_string_lossy().to_string();
            client.execute(
                r#"INSERT INTO chat_hooks (chat_id, folder, child_folder, nix_flake, clipboard_command, build_command, enabled, updated_at)
                   VALUES ($1, $2, $3, $4, $5::jsonb, $6, true, now())
                   ON CONFLICT (chat_id) DO UPDATE SET folder=EXCLUDED.folder,
                     child_folder=EXCLUDED.child_folder, nix_flake=EXCLUDED.nix_flake,
                     clipboard_command=EXCLUDED.clipboard_command, build_command=EXCLUDED.build_command,
                     enabled=true, updated_at=now()"#,
                &[&id, &folder_text, &child_folder, &nix_flake, &command_json, &build_command],
            ).await?;
            println!("hook configured for {id} ({})", chat);
        }
        HookAction::List => {
            let rows = client.query(
                "SELECT h.chat_id, c.title, h.folder, h.child_folder, h.nix_flake, h.enabled, h.build_command FROM chat_hooks h JOIN chats c ON c.id=h.chat_id ORDER BY c.updated_at DESC NULLS LAST",
                &[],
            ).await?;
            if rows.is_empty() { println!("no hooks configured"); }
            for row in rows {
                let id: Uuid = row.get(0); let title: String = row.get(1);
                let folder: String = row.get(2); let child: String = row.get(3);
                let nix: bool = row.get(4); let enabled: bool = row.get(5); let build: Option<String> = row.get(6);
                println!("{} [{}] {} -> {} (build dir: {}; build: {}; nix_flake: {})", id, if enabled { "enabled" } else { "disabled" }, title, folder, child, build.as_deref().unwrap_or("none"), nix);
            }
        }
        HookAction::Show { chat } => {
            let id = resolve_chat_id(client, &chat).await?;
            let row = client.query_opt("SELECT folder, child_folder, nix_flake, clipboard_command, enabled, build_command FROM chat_hooks WHERE chat_id=$1", &[&id]).await?.context("no hook configured for this chat")?;
            let command: serde_json::Value = row.get(3);
            let build_command: Option<String> = row.get(5);
            println!("chat: {id}\nfolder: {}\nchild_folder: {}\nbuild_command: {}\nnix_flake: {}\nenabled: {}\nclipboard_command: {}", row.get::<_, String>(0), row.get::<_, String>(1), build_command.as_deref().unwrap_or("none"), row.get::<_, bool>(2), row.get::<_, bool>(4), command);
        }
        HookAction::Run { chat } => {
            // Kept for completeness; the top-level dispatcher handles this action
            // without a database connection when no explicit chat was supplied.
            let requested_id = if let Some(spec) = chat {
                Some(resolve_chat_id(client, &spec).await?)
            } else {
                None
            };
            let body = match requested_id {
                Some(id) => serde_json::json!({ "chat_id": id }).to_string(),
                None => "{}".to_string(),
            };
            let response = watcher_request("POST", "/hook/run", Some(&body))
                .context("could not trigger hook; is `bun run watch` running?")?;
            let value: serde_json::Value = serde_json::from_str(&response)?;
            let response_id = value.get("chat_id").and_then(|v| v.as_str()).map(str::to_owned);
            let id = response_id.or_else(|| requested_id.map(|id| id.to_string()))
                .context("watcher response did not include the hook chat UUID")?;
            if let Some(path) = value.get("archive").and_then(|v| v.as_str()) {
                println!("hook completed for {id}: {path}");
            } else {
                println!("hook completed for {id}");
            }
        }
        HookAction::Enable { chat } => {
            let id = resolve_chat_id(client, &chat).await?;
            let changed = client.execute("UPDATE chat_hooks SET enabled=true, updated_at=now() WHERE chat_id=$1", &[&id]).await?;
            if changed == 0 { anyhow::bail!("no hook configured for {id}"); }
            println!("hook enabled for {id}");
        }
        HookAction::Disable { chat } => {
            let id = resolve_chat_id(client, &chat).await?;
            let changed = client.execute("UPDATE chat_hooks SET enabled=false, updated_at=now() WHERE chat_id=$1", &[&id]).await?;
            if changed == 0 { anyhow::bail!("no hook configured for {id}"); }
            println!("hook disabled for {id}");
        }
        HookAction::Remove { chat } => {
            let id = resolve_chat_id(client, &chat).await?;
            let changed = client.execute("DELETE FROM chat_hooks WHERE chat_id=$1", &[&id]).await?;
            if changed == 0 { anyhow::bail!("no hook configured for {id}"); }
            println!("removed hook for {id}");
        }
    }
    Ok(())
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

async fn interactive_open(client: &Client) -> Result<Option<Uuid>> {
    // Avoid list_chats(): its per-chat message counts are unnecessary for selection
    // and can be expensive on large history databases.
    let rows = client.query(
        r#"SELECT c.id, COALESCE(c.title, ''), COALESCE(b.browser_name, 'default'),
                  row_number() OVER (ORDER BY c.updated_at DESC NULLS LAST, c.id DESC) - 1 AS chat_index
           FROM chats c
           LEFT JOIN chatgpt_watcher_chat_browsers b ON b.chat_id = c.id
           ORDER BY chat_index"#,
        &[],
    ).await?;
    if rows.is_empty() {
        anyhow::bail!("no chats in database — run `chatgpt-ctl chats --refresh` first");
    }
    let mut child = Command::new("fzf")
        .args(["--ansi", "--delimiter=\t", "--with-nth=2..", "--prompt=chat> ",
               "--header=Search by index, chat UUID or title (Esc to cancel)",
               "--layout=reverse", "--height=80%"])
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .spawn()
        .context("start fzf; install fzf or pass an explicit chat UUID/title/index")?;
    {
        let mut input = child.stdin.take().context("fzf stdin unavailable")?;
        for row in rows {
            let id: Uuid = row.get(0);
            let title: String = row.get(1);
            let browser: String = row.get(2);
            let index: i64 = row.get(3);
            // First field is the selected ID; all remaining fields are searchable.
            let line = format!("{id}\t{index}\t{id}\t{browser}\t{}\n",
                               title.replace('\n', " ").replace('\r', " ").replace('\t', " "));
            if input.write_all(line.as_bytes()).is_err() { break; } // Esc closes fzf early.
        }
    }
    let result = child.wait_with_output().context("wait for fzf")?;
    if !result.status.success() { return Ok(None); } // Escape / Ctrl-C
    let line = String::from_utf8(result.stdout).context("fzf returned invalid UTF-8")?;
    let id = line.split('\t').next().unwrap_or("").trim();
    Ok(Some(Uuid::parse_str(id).context("fzf returned an invalid chat ID")?))
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


/// Return every conversation UUID currently open in a watcher browser pane.
fn watcher_status() -> (Vec<Uuid>, Option<Uuid>) {
    let Ok(response) = watcher_request("GET", "/status", None) else {
        return (Vec::new(), None);
    };
    let Ok(value) = serde_json::from_str::<serde_json::Value>(&response) else {
        return (Vec::new(), None);
    };
    let open = value.get("chat_ids").and_then(|v| v.as_array()).into_iter().flatten()
        .filter_map(|item| item.as_str()?.parse().ok())
        .collect();
    let focused = value.get("chat_id").and_then(|v| v.as_str()).and_then(|id| id.parse().ok());
    (open, focused)
}

fn watcher_open_chats() -> Vec<Uuid> {
    watcher_status().0
}

fn watcher_request(method: &str, path: &str, body: Option<&str>) -> Result<String> {
    let address = std::env::var("CHATGPT_CTL_ADDR").unwrap_or_else(|_| "127.0.0.1:17381".into());
    let mut stream = TcpStream::connect(&address)
        .with_context(|| format!("connect to watcher control server at {address}; start `bun run watch`"))?;
    stream.set_read_timeout(Some(std::time::Duration::from_secs(120)))?;
    let payload = body.unwrap_or("");
    let request = format!(
        "{method} {path} HTTP/1.1\r\nHost: {address}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{payload}",
        payload.len()
    );
    stream.write_all(request.as_bytes())?;
    let mut response = String::new();
    stream.read_to_string(&mut response)?;
    let (headers, body) = response.split_once("\r\n\r\n").unwrap_or((&response, ""));
    let status = headers.lines().next().unwrap_or("HTTP/1.1 500");
    if !status.contains(" 200 ") { anyhow::bail!("watcher request failed ({status}): {body}"); }
    Ok(body.to_string())
}


#[tokio::main]
async fn main() -> Result<()> {
    let cli = Cli::parse();
    let url = cli
        .database_url
        .clone()
        .unwrap_or_else(default_database_url);

    match cli.command {
        Commands::Retry { chat, mode } => {
            let client = connect(&url).await?;
            set_retry_setting(&client, &chat, mode).await?;
        }
        Commands::Hook { action: HookAction::Run { chat } } => {
            run_hook_request(chat, &url).await?;
        }
        Commands::Hook { action } => {
            let client = connect(&url).await?;
            run_hook_action(&client, action).await?;
        }
        Commands::CompleteChat { prefix } => {
            let client = connect(&url).await?;
            complete_chat_values(&client, prefix.as_deref().unwrap_or("")).await?;
        }
        Commands::Completions { shell } => {
            let mut cmd = Cli::command();
            if matches!(shell, ShellKind::Zsh) {
                print_zsh_completions(&mut cmd)?;
            } else {
                let shell: Shell = shell.into();
                generate(shell, &mut cmd, "chatgpt-ctl", &mut io::stdout());
            }
            return Ok(());
        }
        Commands::Chats { limit, query, refresh } => {
            if refresh {
                // Prefer the already-running watcher so profile locks are never
                // contended by a second Chromium process. Fall back to a one-shot
                // sync when the control server is not running.
                match watcher_request("POST", "/sync-chats", Some("{}")) {
                    Ok(_) => {}
                    Err(error) if format!("{error:#}").contains("connect to watcher control server") => {
                        run_watcher(&watcher_args("sync-chats", &["--quiet".to_string()]))?;
                    }
                    Err(error) => return Err(error),
                }
            }
            let client = connect(&url).await?;
            let chats = list_chats(&client, limit, query.as_deref()).await?;
            let (open_chats, focused_chat) = watcher_status();
            println!("  #  BROWSER       STATE     CHAT ID                                  MSGS  UPDATED          TITLE");
            for c in chats.iter() {
                let ts = c.updated_at
                    .map(|t| t.format("%Y-%m-%d %H:%M").to_string())
                    .unwrap_or_else(|| "-".into());
                let pane_index = open_chats.iter().position(|id| *id == c.id);
                let state = if focused_chat == Some(c.id) { "FOCUSED" } else if pane_index.is_some() { "OPEN" } else { "" };
                let line = format!("{:>3}  {:<12}  {:<8}  {}  {:>4}  {:<16}  {}", c.global_index, c.browser_name, state, c.id, c.message_count, ts, c.title.replace('\n', " ").replace('\r', " "));
                if focused_chat == Some(c.id) {
                    println!("\x1b[1;30;103m▶ {line}\x1b[0m");
                } else if pane_index.is_some() {
                    println!("\x1b[1;36m● {line}\x1b[0m");
                } else {
                    println!("  {line}");
                }
            }
        }
        Commands::Send { text, chat, files, new_chat, draft } => {
            let text = text.unwrap_or_default();
            if text.trim().is_empty() && files.is_empty() {
                anyhow::bail!("send: provide message text or at least one --file attachment");
            }
            let chat_id = if let Some(spec) = chat {
                let client = connect(&url).await?;
                Some(resolve_chat_id(&client, &spec).await?)
            } else {
                None
            };
            let mut resolved_files = Vec::with_capacity(files.len());
            for file in files {
                let file = file
                    .canonicalize()
                    .with_context(|| format!("access attachment {}", file.display()))?;
                resolved_files.push(file);
            }
            let body = serde_json::json!({
                "chat_id": chat_id,
                "new_chat": new_chat,
                "text": text,
                "files": resolved_files,
                "draft": draft,
            }).to_string();
            let response = watcher_request("POST", "/send", Some(&body))?;
            let value: serde_json::Value = serde_json::from_str(&response)?;
            let destination = value.get("chat_id").and_then(|v| v.as_str()).unwrap_or("focused chat");
            let browser_name = value.get("browser_name").and_then(|v| v.as_str()).unwrap_or("default");
            let url = value.get("url").and_then(|v| v.as_str()).unwrap_or("ChatGPT pane");
            if draft {
                println!("draft prepared in {destination} [{browser_name}] ({url}); message was not sent");
            } else if new_chat {
                println!("message sent to new chat {destination} [{browser_name}] ({url})");
            } else {
                println!("message sent to {destination} [{browser_name}] ({url})");
            }
        }
        Commands::Open { chat } => {
            let command_started = std::time::Instant::now();
            // UUIDs require no DB lookup. All other selectors need a DB query;
            // fzf is launched only when no argument is provided.
            let chat_id = match chat {
                Some(spec) => match Uuid::parse_str(&spec) {
                    Ok(id) => id,
                    Err(_) => {
                        let client = connect(&url).await?;
                        resolve_chat_id(&client, &spec).await?
                    }
                },
                None => {
                    let client = connect(&url).await?;
                    match interactive_open(&client).await? {
                        Some(id) => id,
                        None => return Ok(()),
                    }
                }
            };
            let (open_chats, focused_chat) = watcher_status();
            if focused_chat == Some(chat_id) && open_chats.contains(&chat_id) {
                // Do not call /open or bringToFront for an already focused chat.
                println!("chat {chat_id} is already under virtual focus (no action; {} ms)",
                    command_started.elapsed().as_millis());
                return Ok(());
            }
            let body = serde_json::json!({ "chat_id": chat_id }).to_string();
            let response = watcher_request("POST", "/open", Some(&body))?;
            let value: serde_json::Value = serde_json::from_str(&response)?;
            let already_open = value.get("already_open").and_then(|v| v.as_bool()).unwrap_or(false);
            let pane_index = value.get("pane_index").and_then(|v| v.as_i64());
            let browser_name = value.get("browser_name").and_then(|v| v.as_str()).unwrap_or("default");
            let watcher_ms = value.get("duration_ms").and_then(|v| v.as_u64()).unwrap_or(0);
            let total_ms = command_started.elapsed().as_millis();
            if already_open {
                println!("focused existing pane{} for {chat_id} in browser {browser_name} (total {total_ms} ms; watcher {watcher_ms} ms)", pane_index.map(|i| format!(" [{i}] ")).unwrap_or_else(|| " ".into()));
            } else {
                println!("opened {chat_id} in browser {browser_name} in a new pane{} (total {total_ms} ms; watcher {watcher_ms} ms)", pane_index.map(|i| format!(" [{i}] ")).unwrap_or_default());
            }
        }
        Commands::Close { chat } => {
            let client = connect(&url).await?;
            let chat_id = resolve_chat_id(&client, &chat).await?;
            let body = serde_json::json!({ "chat_id": chat_id }).to_string();
            let response = watcher_request("POST", "/close", Some(&body))?;
            let value: serde_json::Value = serde_json::from_str(&response)?;
            let browser_name = value.get("browser_name").and_then(|v| v.as_str()).unwrap_or("unknown");
            println!("closed {} from browser {browser_name}", value.get("closed_chat_id").and_then(|v| v.as_str()).unwrap_or(&chat));
        }
        Commands::NewChat => {
            let response = watcher_request("POST", "/new-chat", Some("{}"))?;
            let value: serde_json::Value = serde_json::from_str(&response)?;
            println!("opened blank chat in a new pane ({})", value.get("url").and_then(|v| v.as_str()).unwrap_or("ChatGPT"));
        }
        Commands::DownloadLastZip { directory, chat, extract_to } => {
            let chat_id = if let Some(spec) = chat {
                let client = connect(&url).await?;
                Some(resolve_chat_id(&client, &spec).await?)
            } else {
                None
            };
            let cwd = std::env::current_dir()?;
            let absolute = |value: Option<PathBuf>| -> Option<PathBuf> {
                value.map(|path| if path.is_absolute() { path } else { cwd.join(path) })
            };
            let body = serde_json::json!({
                "chat_id": chat_id,
                "directory": absolute(directory),
                "extract_to": absolute(extract_to),
            }).to_string();
            let response = watcher_request("POST", "/download-last-zip", Some(&body))?;
            let value: serde_json::Value = serde_json::from_str(&response)?;
            println!("{} [browser: {}]", value.get("path").and_then(|v| v.as_str()).unwrap_or("download complete"), value.get("browser_name").and_then(|v| v.as_str()).unwrap_or("virtual focus"));
            if let Some(destination) = value.get("extracted_to").and_then(|v| v.as_str()) {
                println!("extracted to {destination}");
            }
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


#[cfg(test)]
mod cli_completion_tests {
    use super::*;

    #[test]
    fn zsh_completion_supports_path_invocations_and_dynamic_chat_targets() {
        let mut command = Cli::command();
        let completion = zsh_completion_text(&mut command).expect("zsh completion output");
        assert!(completion.starts_with("#compdef -p '*chatgpt-ctl' ctl"));
        assert!(completion.contains("__complete-chat"));
        assert!(completion.contains("hook"));
        assert!(completion.contains("--folder"));
        assert!(completion.contains("--child-folder"));
    }

    #[test]
    fn download_last_zip_is_exposed_to_clap_shell_completions() {
        let command = Cli::command();
        assert!(command.find_subcommand("download-last-zip").is_some());
    }

    #[test]
    fn hook_management_is_exposed_to_clap_shell_completions() {
        let command = Cli::command();
        let hook = command.find_subcommand("hook").expect("hook command");
        assert!(hook.find_subcommand("set").is_some());
        assert!(hook.find_subcommand("list").is_some());
        assert!(hook.find_subcommand("remove").is_some());
    }

    #[test]
    fn automatic_retry_command_is_exposed_to_clap_shell_completions() {
        assert!(Cli::command().find_subcommand("retry").is_some());
    }

    #[test]
    fn multi_pane_commands_are_exposed_to_clap_shell_completions() {
        let command = Cli::command();
        assert!(command.find_subcommand("open").is_some());
        assert!(command.find_subcommand("close").is_some());
        assert!(command.find_subcommand("chats").is_some());
    }

    #[test]
    fn send_accepts_an_explicit_chat_target() {
        let cli = Cli::try_parse_from([
            "chatgpt-ctl", "send", "hello", "--chat", "NixOS Wayland",
        ]).expect("send with --chat should parse");
        match cli.command {
            Commands::Send { text, chat, new_chat, .. } => {
                assert_eq!(text.as_deref(), Some("hello"));
                assert_eq!(chat.as_deref(), Some("NixOS Wayland"));
                assert!(!new_chat);
            }
            _ => panic!("expected send command"),
        }
    }

    #[test]
    fn send_can_create_a_new_chat() {
        let cli = Cli::try_parse_from(["chatgpt-ctl", "send", "--new-chat", "first prompt"])
            .expect("send --new-chat should parse");
        match cli.command {
            Commands::Send { text, chat, new_chat, .. } => {
                assert_eq!(text.as_deref(), Some("first prompt"));
                assert!(chat.is_none());
                assert!(new_chat);
            }
            _ => panic!("expected send command"),
        }
    }

    #[test]
    fn send_draft_accepts_text_and_file_without_submitting() {
        let cli = Cli::try_parse_from([
            "chatgpt-ctl", "send", "--draft", "Review this archive", "--file", "./project.zip",
        ]).expect("send --draft should parse");
        match cli.command {
            Commands::Send { text, files, draft, new_chat, .. } => {
                assert_eq!(text.as_deref(), Some("Review this archive"));
                assert_eq!(files.len(), 1);
                assert!(draft);
                assert!(!new_chat);
            }
            _ => panic!("expected send command"),
        }
    }
}
