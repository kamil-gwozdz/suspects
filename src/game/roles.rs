use serde::{Deserialize, Serialize};

/// Factions in the game. Currently Town vs Mafia with some Neutrals.
/// Designed to be extensible — future factions (e.g. Cult, Vampires, Third Party)
/// can be added here without breaking existing logic.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Faction {
    Town,
    Mafia,
    Neutral,
    // Future factions:
    // Cult,
    // Vampires,
    // Aliens,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Role {
    // Town
    Civilian,
    Doctor,
    Detective,
    Escort,
    Vigilante,
    Mayor,
    Spy,
    // Mafia
    Mafioso,
    Godfather,
    Consort,
    Janitor,
    // Neutral
    Jester,
    SerialKiller,
    Survivor,
    Executioner,
    Witch,
}

impl Role {
    pub fn faction(&self) -> Faction {
        match self {
            Role::Civilian | Role::Doctor | Role::Detective | Role::Escort
            | Role::Vigilante | Role::Mayor | Role::Spy => Faction::Town,
            Role::Mafioso | Role::Godfather | Role::Consort | Role::Janitor => Faction::Mafia,
            Role::Jester | Role::SerialKiller | Role::Survivor
            | Role::Executioner | Role::Witch => Faction::Neutral,
        }
    }

    pub fn has_night_action(&self) -> bool {
        !matches!(self, Role::Civilian | Role::Mayor | Role::Jester | Role::Survivor)
    }

    pub fn is_immune_to_mafia(&self) -> bool {
        matches!(self, Role::SerialKiller | Role::Godfather)
    }

    pub fn description_key(&self) -> &'static str {
        match self {
            Role::Civilian => "role_civilian",
            Role::Doctor => "role_doctor",
            Role::Detective => "role_detective",
            Role::Escort => "role_escort",
            Role::Vigilante => "role_vigilante",
            Role::Mayor => "role_mayor",
            Role::Spy => "role_spy",
            Role::Mafioso => "role_mafioso",
            Role::Godfather => "role_godfather",
            Role::Consort => "role_consort",
            Role::Janitor => "role_janitor",
            Role::Jester => "role_jester",
            Role::SerialKiller => "role_serial_killer",
            Role::Survivor => "role_survivor",
            Role::Executioner => "role_executioner",
            Role::Witch => "role_witch",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_factions() {
        assert_eq!(Role::Doctor.faction(), Faction::Town);
        assert_eq!(Role::Mafioso.faction(), Faction::Mafia);
        assert_eq!(Role::Jester.faction(), Faction::Neutral);
        assert_eq!(Role::Godfather.faction(), Faction::Mafia);
        assert_eq!(Role::SerialKiller.faction(), Faction::Neutral);
    }

    #[test]
    fn test_night_actions() {
        assert!(Role::Doctor.has_night_action());
        assert!(Role::Mafioso.has_night_action());
        assert!(!Role::Civilian.has_night_action());
        assert!(!Role::Mayor.has_night_action());
    }

    #[test]
    fn test_mafia_immunity() {
        assert!(Role::SerialKiller.is_immune_to_mafia());
        assert!(Role::Godfather.is_immune_to_mafia());
        assert!(!Role::Doctor.is_immune_to_mafia());
    }
}
