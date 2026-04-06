use std::collections::HashMap;
use std::sync::Arc;
use std::time::Instant;
use tokio::sync::{Mutex, RwLock};
use sqlx::SqlitePool;
use uuid::Uuid;
use rand::Rng;

use crate::game::state::{GamePhase, GameState};
use crate::game::roles::Role;
use crate::ws::messages::PlayerInfo;

#[derive(Debug, Clone)]
pub struct Player {
    pub id: String,
    pub name: String,
    pub role: Option<Role>,
    pub alive: bool,
    pub connected: bool,
    pub disconnected_at: Option<Instant>,
    pub tx: Option<tokio::sync::mpsc::UnboundedSender<String>>,
}

impl Player {
    pub fn to_info(&self) -> PlayerInfo {
        PlayerInfo {
            id: self.id.clone(),
            name: self.name.clone(),
            alive: self.alive,
        }
    }
}

#[derive(Debug)]
pub struct Room {
    pub id: String,
    pub code: String,
    pub language: String,
    pub game_state: GameState,
    pub players: Vec<Player>,
    pub host_tx: Option<tokio::sync::mpsc::UnboundedSender<String>>,
    pub votes: HashMap<String, Option<String>>,
    pub night_actions: Vec<crate::game::phases::NightAction>,
}

impl Room {
    pub fn new(language: String) -> Self {
        let code = generate_room_code();
        Self {
            id: Uuid::new_v4().to_string(),
            code,
            language,
            game_state: GameState::default(),
            players: Vec::new(),
            host_tx: None,
            votes: HashMap::new(),
            night_actions: Vec::new(),
        }
    }

    pub fn add_player(&mut self, name: String) -> String {
        let id = Uuid::new_v4().to_string();
        self.players.push(Player {
            id: id.clone(),
            name,
            role: None,
            alive: true,
            connected: true,
            disconnected_at: None,
            tx: None,
        });
        id
    }

    /// Remove a player by ID. Only allowed during Lobby phase.
    /// Returns the removed player's name if successful.
    pub fn remove_player(&mut self, id: &str) -> Option<String> {
        if self.game_state.phase != GamePhase::Lobby {
            return None;
        }
        if let Some(pos) = self.players.iter().position(|p| p.id == id) {
            let player = self.players.remove(pos);
            Some(player.name)
        } else {
            None
        }
    }

    /// Returns a snapshot of current game state for reconnecting players.
    pub fn get_game_snapshot(&self) -> GameSnapshot {
        GameSnapshot {
            phase: self.game_state.phase,
            round: self.game_state.round,
            alive_players: self.alive_players().iter().map(|p| p.to_info()).collect(),
        }
    }

    pub fn alive_players(&self) -> Vec<&Player> {
        self.players.iter().filter(|p| p.alive).collect()
    }

    pub fn get_player(&self, id: &str) -> Option<&Player> {
        self.players.iter().find(|p| p.id == id)
    }

    pub fn get_player_mut(&mut self, id: &str) -> Option<&mut Player> {
        self.players.iter_mut().find(|p| p.id == id)
    }

    pub fn broadcast_to_players(&self, msg: &str) {
        for player in &self.players {
            if let Some(ref tx) = player.tx {
                let _ = tx.send(msg.to_string());
            }
        }
    }

    pub fn send_to_host(&self, msg: &str) {
        if let Some(ref tx) = self.host_tx {
            let _ = tx.send(msg.to_string());
        }
    }

    pub fn send_to_player(&self, player_id: &str, msg: &str) {
        if let Some(player) = self.get_player(player_id) {
            if let Some(ref tx) = player.tx {
                let _ = tx.send(msg.to_string());
            }
        }
    }
}

#[derive(Debug, Clone)]
pub struct GameSnapshot {
    pub phase: GamePhase,
    pub round: u32,
    pub alive_players: Vec<PlayerInfo>,
}

fn generate_room_code() -> String {
    let mut rng = rand::rng();
    let chars: Vec<char> = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789".chars().collect();
    (0..4).map(|_| chars[rng.random_range(0..chars.len())]).collect()
}

#[derive(Clone)]
pub struct AppState {
    pub rooms: Arc<RwLock<HashMap<String, Arc<Mutex<Room>>>>>,
    pub pool: SqlitePool,
}

impl AppState {
    pub fn new(pool: SqlitePool) -> Self {
        Self {
            rooms: Arc::new(RwLock::new(HashMap::new())),
            pool,
        }
    }

    pub async fn create_room(&self, language: String) -> String {
        let room = Room::new(language);
        let code = room.code.clone();
        let mut rooms = self.rooms.write().await;
        rooms.insert(code.clone(), Arc::new(Mutex::new(room)));
        code
    }

    pub async fn get_room(&self, code: &str) -> Option<Arc<Mutex<Room>>> {
        let rooms = self.rooms.read().await;
        rooms.get(code).cloned()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_room_code_format() {
        let code = generate_room_code();
        assert_eq!(code.len(), 4);
        assert!(code.chars().all(|c| c.is_ascii_alphanumeric()));
        // Should not contain easily confused characters
        assert!(!code.contains('O'));
        assert!(!code.contains('I'));
        assert!(!code.contains('0'));
        assert!(!code.contains('1'));
    }

    #[test]
    fn test_add_player() {
        let mut room = Room::new("en".to_string());
        let id = room.add_player("Alice".to_string());
        assert!(!id.is_empty());
        assert_eq!(room.players.len(), 1);
        assert_eq!(room.players[0].name, "Alice");
    }

    #[test]
    fn test_alive_players() {
        let mut room = Room::new("en".to_string());
        room.add_player("Alice".to_string());
        room.add_player("Bob".to_string());
        room.players[0].alive = false;
        assert_eq!(room.alive_players().len(), 1);
    }

    #[test]
    fn test_remove_player_in_lobby() {
        let mut room = Room::new("en".to_string());
        let id = room.add_player("Alice".to_string());
        room.add_player("Bob".to_string());
        assert_eq!(room.players.len(), 2);

        let name = room.remove_player(&id);
        assert_eq!(name, Some("Alice".to_string()));
        assert_eq!(room.players.len(), 1);
        assert_eq!(room.players[0].name, "Bob");
    }

    #[test]
    fn test_remove_player_not_in_lobby() {
        let mut room = Room::new("en".to_string());
        let id = room.add_player("Alice".to_string());
        room.game_state.next_phase(); // RoleReveal
        let name = room.remove_player(&id);
        assert_eq!(name, None);
        assert_eq!(room.players.len(), 1);
    }

    #[test]
    fn test_remove_nonexistent_player() {
        let mut room = Room::new("en".to_string());
        room.add_player("Alice".to_string());
        let name = room.remove_player("nonexistent");
        assert_eq!(name, None);
        assert_eq!(room.players.len(), 1);
    }

    #[test]
    fn test_get_game_snapshot() {
        let mut room = Room::new("en".to_string());
        room.add_player("Alice".to_string());
        room.add_player("Bob".to_string());
        room.players[0].alive = false;

        let snapshot = room.get_game_snapshot();
        assert_eq!(snapshot.phase, crate::game::state::GamePhase::Lobby);
        assert_eq!(snapshot.round, 0);
        assert_eq!(snapshot.alive_players.len(), 1);
        assert_eq!(snapshot.alive_players[0].name, "Bob");
    }

    #[test]
    fn test_disconnection_timestamp() {
        let mut room = Room::new("en".to_string());
        let id = room.add_player("Alice".to_string());
        let player = room.get_player_mut(&id).unwrap();
        assert!(player.disconnected_at.is_none());

        let now = std::time::Instant::now();
        player.connected = false;
        player.disconnected_at = Some(now);
        assert!(player.disconnected_at.is_some());

        // Simulate reconnect
        player.connected = true;
        player.disconnected_at = None;
        assert!(player.disconnected_at.is_none());
    }
}
