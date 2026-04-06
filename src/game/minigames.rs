use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MiniGameType {
    PrisonersDilemma,
    TrustCircle,
    AlibiChallenge,
    Interrogation,
    SecretVote,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MiniGameConfig {
    pub game_type: MiniGameType,
    pub timer_secs: u32,
}

// Mini-game implementations will be added in Phase 5
