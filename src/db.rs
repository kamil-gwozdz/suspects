use sqlx::sqlite::SqliteRow;
use sqlx::{Row, SqlitePool};

use crate::game::roles::Role;
use crate::game::state::{GamePhase, GameState};

/// Lightweight snapshot of room data for persistence (Send + Sync safe).
#[derive(Debug, Clone)]
pub struct RoomSnapshot {
    pub id: String,
    pub code: String,
    pub language: String,
    pub game_state: GameState,
    pub players: Vec<PlayerSnapshot>,
}

#[derive(Debug, Clone)]
pub struct PlayerSnapshot {
    pub id: String,
    pub name: String,
    pub role: Option<Role>,
    pub alive: bool,
    pub connected: bool,
}

impl RoomSnapshot {
    /// Build a snapshot from a live Room (call while holding the lock).
    pub fn from_room(room: &crate::rooms::manager::Room) -> Self {
        Self {
            id: room.id.clone(),
            code: room.code.clone(),
            language: room.language.clone(),
            game_state: room.game_state.clone(),
            players: room.players.iter().map(|p| PlayerSnapshot {
                id: p.id.clone(),
                name: p.name.clone(),
                role: p.role,
                alive: p.alive,
                connected: p.connected,
            }).collect(),
        }
    }
}

pub async fn run_migrations(pool: &SqlitePool) {
    // Drop legacy tables if they have the old schema (state/config columns).
    // These tables were never written to, so no data is lost.
    let has_old_schema = sqlx::query(
        "SELECT COUNT(*) as cnt FROM pragma_table_info('games') WHERE name = 'state'"
    )
    .fetch_one(pool)
    .await
    .map(|row: SqliteRow| row.get::<i32, _>("cnt") > 0)
    .unwrap_or(false);

    if has_old_schema {
        tracing::info!("Detected legacy schema, recreating tables");
        for table in &["game_events", "players", "games"] {
            let _ = sqlx::query(&format!("DROP TABLE IF EXISTS {}", table))
                .execute(pool)
                .await;
        }
    }

    sqlx::query(
        "CREATE TABLE IF NOT EXISTS games (
            id TEXT PRIMARY KEY,
            room_code TEXT NOT NULL UNIQUE,
            phase TEXT NOT NULL DEFAULT 'lobby',
            round INTEGER NOT NULL DEFAULT 0,
            language TEXT NOT NULL DEFAULT 'en',
            day_timer_secs INTEGER NOT NULL DEFAULT 300,
            night_timer_secs INTEGER NOT NULL DEFAULT 60,
            voting_timer_secs INTEGER NOT NULL DEFAULT 60,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )"
    )
    .execute(pool)
    .await
    .expect("Failed to create games table");

    sqlx::query(
        "CREATE TABLE IF NOT EXISTS players (
            id TEXT PRIMARY KEY,
            game_id TEXT NOT NULL REFERENCES games(id),
            name TEXT NOT NULL,
            role TEXT,
            is_alive INTEGER NOT NULL DEFAULT 1,
            connected INTEGER NOT NULL DEFAULT 1,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )"
    )
    .execute(pool)
    .await
    .expect("Failed to create players table");

    sqlx::query(
        "CREATE TABLE IF NOT EXISTS game_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            game_id TEXT NOT NULL REFERENCES games(id),
            round INTEGER NOT NULL,
            phase TEXT NOT NULL,
            event_type TEXT NOT NULL,
            data TEXT NOT NULL DEFAULT '{}',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )"
    )
    .execute(pool)
    .await
    .expect("Failed to create game_events table");

    tracing::info!("Database migrations completed");
}

// ---------------------------------------------------------------------------
// Persistence helpers — all operations are fire-and-forget safe (log on error)
// ---------------------------------------------------------------------------

/// Insert or update a game record from a room snapshot.
pub async fn save_game(pool: &SqlitePool, room: &RoomSnapshot) {
    let phase_str = serde_json::to_string(&room.game_state.phase).unwrap_or_default();
    let phase_str = phase_str.trim_matches('"');

    let res = sqlx::query(
        "INSERT INTO games (id, room_code, phase, round, language, day_timer_secs, night_timer_secs, voting_timer_secs, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, CURRENT_TIMESTAMP)
         ON CONFLICT(id) DO UPDATE SET
             phase = excluded.phase,
             round = excluded.round,
             updated_at = CURRENT_TIMESTAMP"
    )
    .bind(&room.id)
    .bind(&room.code)
    .bind(phase_str)
    .bind(room.game_state.round as i64)
    .bind(&room.language)
    .bind(room.game_state.day_timer_secs as i64)
    .bind(room.game_state.night_timer_secs as i64)
    .bind(room.game_state.voting_timer_secs as i64)
    .execute(pool)
    .await;

    if let Err(e) = res {
        tracing::error!(room_code = %room.code, error = %e, "Failed to save game");
    }
}

/// Insert or update a player record.
pub async fn save_player(pool: &SqlitePool, game_id: &str, player: &PlayerSnapshot) {
    let role_str = player.role.map(|r| {
        let s = serde_json::to_string(&r).unwrap_or_default();
        s.trim_matches('"').to_string()
    });

    let res = sqlx::query(
        "INSERT INTO players (id, game_id, name, role, is_alive, connected)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT(id) DO UPDATE SET
             role = excluded.role,
             is_alive = excluded.is_alive,
             connected = excluded.connected"
    )
    .bind(&player.id)
    .bind(game_id)
    .bind(&player.name)
    .bind(&role_str)
    .bind(player.alive as i32)
    .bind(player.connected as i32)
    .execute(pool)
    .await;

    if let Err(e) = res {
        tracing::error!(player_id = %player.id, error = %e, "Failed to save player");
    }
}

/// Bulk-save all players in a room snapshot.
pub async fn save_all_players(pool: &SqlitePool, room: &RoomSnapshot) {
    for player in &room.players {
        save_player(pool, &room.id, player).await;
    }
}

/// Log a phase transition as a game event and update the game record.
pub async fn save_phase_transition(pool: &SqlitePool, room: &RoomSnapshot) {
    save_game(pool, room).await;

    let phase_str = serde_json::to_string(&room.game_state.phase).unwrap_or_default();
    let phase_str = phase_str.trim_matches('"');

    let res = sqlx::query(
        "INSERT INTO game_events (game_id, round, phase, event_type, data)
         VALUES (?1, ?2, ?3, 'phase_transition', '{}')"
    )
    .bind(&room.id)
    .bind(room.game_state.round as i64)
    .bind(phase_str)
    .execute(pool)
    .await;

    if let Err(e) = res {
        tracing::error!(room_code = %room.code, error = %e, "Failed to save phase transition");
    }
}

/// Log an arbitrary game event (kill, heal, vote, etc.).
pub async fn save_game_event(
    pool: &SqlitePool,
    game_id: &str,
    round: u32,
    phase: GamePhase,
    event_type: &str,
    data: &serde_json::Value,
) {
    let phase_str = serde_json::to_string(&phase).unwrap_or_default();
    let phase_str = phase_str.trim_matches('"');
    let data_str = data.to_string();

    let res = sqlx::query(
        "INSERT INTO game_events (game_id, round, phase, event_type, data)
         VALUES (?1, ?2, ?3, ?4, ?5)"
    )
    .bind(game_id)
    .bind(round as i64)
    .bind(phase_str)
    .bind(event_type)
    .bind(&data_str)
    .execute(pool)
    .await;

    if let Err(e) = res {
        tracing::error!(game_id = %game_id, error = %e, "Failed to save game event");
    }
}

/// Mark a game as completed (game_over phase).
pub async fn mark_game_completed(pool: &SqlitePool, game_id: &str) {
    let res = sqlx::query(
        "UPDATE games SET phase = 'game_over', updated_at = CURRENT_TIMESTAMP WHERE id = ?1"
    )
    .bind(game_id)
    .execute(pool)
    .await;

    if let Err(e) = res {
        tracing::error!(game_id = %game_id, error = %e, "Failed to mark game completed");
    }
}

// ---------------------------------------------------------------------------
// Recovery — load active games from DB on server startup
// ---------------------------------------------------------------------------

fn parse_phase(s: &str) -> GamePhase {
    // Try serde deserialization (handles snake_case values)
    if let Ok(p) = serde_json::from_str::<GamePhase>(&format!("\"{}\"", s)) {
        return p;
    }
    GamePhase::Lobby
}

fn parse_role(s: &str) -> Option<Role> {
    serde_json::from_str::<Role>(&format!("\"{}\"", s)).ok()
}

/// Represents a game row loaded from the database.
pub struct LoadedGame {
    pub id: String,
    pub code: String,
    pub language: String,
    pub phase: GamePhase,
    pub round: u32,
    pub day_timer_secs: u32,
    pub night_timer_secs: u32,
    pub voting_timer_secs: u32,
    pub players: Vec<LoadedPlayer>,
}

pub struct LoadedPlayer {
    pub id: String,
    pub name: String,
    pub role: Option<Role>,
    pub alive: bool,
}

/// Load all games that were in-progress (not lobby, not game_over) when the
/// server last shut down. Returns reconstructable game state.
pub async fn load_active_games(pool: &SqlitePool) -> Vec<LoadedGame> {
    let game_rows: Vec<SqliteRow> = match sqlx::query(
        "SELECT id, room_code, phase, round, language,
                day_timer_secs, night_timer_secs, voting_timer_secs
         FROM games
         WHERE phase NOT IN ('lobby', 'game_over')
         ORDER BY created_at DESC"
    )
    .fetch_all(pool)
    .await
    {
        Ok(rows) => rows,
        Err(e) => {
            tracing::error!(error = %e, "Failed to load active games");
            return Vec::new();
        }
    };

    let mut games = Vec::new();

    for row in &game_rows {
        let game_id: String = row.get("id");
        let code: String = row.get("room_code");
        let phase_str: String = row.get("phase");
        let round: i64 = row.get("round");
        let language: String = row.get("language");
        let day_timer: i64 = row.get("day_timer_secs");
        let night_timer: i64 = row.get("night_timer_secs");
        let voting_timer: i64 = row.get("voting_timer_secs");

        let player_rows: Vec<SqliteRow> = match sqlx::query(
            "SELECT id, name, role, is_alive FROM players WHERE game_id = ?1"
        )
        .bind(&game_id)
        .fetch_all(pool)
        .await
        {
            Ok(rows) => rows,
            Err(e) => {
                tracing::warn!(game_id = %game_id, error = %e, "Failed to load players, skipping game");
                continue;
            }
        };

        if player_rows.is_empty() {
            tracing::warn!(game_id = %game_id, "No players found, skipping game");
            continue;
        }

        let players: Vec<LoadedPlayer> = player_rows
            .iter()
            .map(|pr| {
                let role_str: Option<String> = pr.get("role");
                LoadedPlayer {
                    id: pr.get("id"),
                    name: pr.get("name"),
                    role: role_str.and_then(|s| parse_role(&s)),
                    alive: pr.get::<i32, _>("is_alive") != 0,
                }
            })
            .collect();

        games.push(LoadedGame {
            id: game_id,
            code,
            language,
            phase: parse_phase(&phase_str),
            round: round as u32,
            day_timer_secs: day_timer as u32,
            night_timer_secs: night_timer as u32,
            voting_timer_secs: voting_timer as u32,
            players,
        });
    }

    games
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_phase() {
        assert_eq!(parse_phase("lobby"), GamePhase::Lobby);
        assert_eq!(parse_phase("night"), GamePhase::Night);
        assert_eq!(parse_phase("role_reveal"), GamePhase::RoleReveal);
        assert_eq!(parse_phase("game_over"), GamePhase::GameOver);
        assert_eq!(parse_phase("voting"), GamePhase::Voting);
        // unknown falls back to Lobby
        assert_eq!(parse_phase("nonsense"), GamePhase::Lobby);
    }

    #[test]
    fn test_parse_role() {
        assert_eq!(parse_role("doctor"), Some(Role::Doctor));
        assert_eq!(parse_role("mafioso"), Some(Role::Mafioso));
        assert_eq!(parse_role("serial_killer"), Some(Role::SerialKiller));
        assert_eq!(parse_role("invalid"), None);
    }
}
