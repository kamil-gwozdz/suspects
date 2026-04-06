use serde::{Deserialize, Serialize};
use super::roles::Role;

/// What the narrator waits for before proceeding to the next step.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WaitFor {
    /// Auto-advance after N seconds.
    Duration(u32),
    /// Wait for the active player to press "Done".
    PlayerAction,
    /// Wait for host to click next.
    HostAdvance,
}

/// A single step in the narration script.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NarrationStep {
    /// i18n key and audio file reference (e.g. "night.everyone_close_eyes")
    pub key: String,
    /// English display text for TV
    pub text: String,
    /// Path to audio file (e.g. "/audio/gm/night/everyone_close_eyes.mp3")
    pub audio_file: String,
    /// What to wait for before proceeding
    pub wait_for: WaitFor,
    /// Which role this step is for (if any)
    pub target_role: Option<Role>,
}

/// The fixed wake order during the night phase.
const WAKE_ORDER: &[Role] = &[
    Role::Escort,
    Role::Consort,
    Role::Mafioso, // represents the Mafia kill action (Godfather uses same slot)
    Role::Doctor,
    Role::Detective,
    Role::Vigilante,
    Role::SerialKiller,
    Role::Witch,
];

/// Returns the display name used in narration for a given role.
fn role_display_name(role: Role) -> &'static str {
    match role {
        Role::Escort => "Escort",
        Role::Consort => "Consort",
        Role::Mafioso | Role::Godfather => "Mafia",
        Role::Doctor => "Doctor",
        Role::Detective => "Detective",
        Role::Vigilante => "Vigilante",
        Role::SerialKiller => "Serial Killer",
        Role::Witch => "Witch",
        Role::Janitor => "Janitor",
        Role::Spy => "Spy",
        Role::Civilian => "Civilian",
        Role::Mayor => "Mayor",
        Role::Jester => "Jester",
        Role::Survivor => "Survivor",
        Role::Executioner => "Executioner",
    }
}

/// Returns the snake_case key fragment for a role (used in audio paths and i18n keys).
fn role_key(role: Role) -> &'static str {
    match role {
        Role::Escort => "escort",
        Role::Consort => "consort",
        Role::Mafioso | Role::Godfather => "mafia",
        Role::Doctor => "doctor",
        Role::Detective => "detective",
        Role::Vigilante => "vigilante",
        Role::SerialKiller => "serial_killer",
        Role::Witch => "witch",
        Role::Janitor => "janitor",
        Role::Spy => "spy",
        Role::Civilian => "civilian",
        Role::Mayor => "mayor",
        Role::Jester => "jester",
        Role::Survivor => "survivor",
        Role::Executioner => "executioner",
    }
}

/// Returns the night-action instruction text spoken by the GM for a role.
fn role_instruction(role: Role) -> &'static str {
    match role {
        Role::Escort => "Choose someone to distract tonight.",
        Role::Consort => "Choose someone to distract tonight.",
        Role::Mafioso | Role::Godfather => "Choose your victim.",
        Role::Doctor => "Choose someone to protect tonight.",
        Role::Detective => "Choose someone to investigate.",
        Role::Vigilante => "Choose someone to shoot, or hold your fire.",
        Role::SerialKiller => "Choose your next victim.",
        Role::Witch => "Choose someone to control, and pick their target.",
        _ => "Perform your action.",
    }
}

/// Returns the canonical wake-order role for a given role.
/// Godfather and Janitor act during the Mafia wake slot.
fn canonical_wake_role(role: Role) -> Option<Role> {
    match role {
        Role::Escort => Some(Role::Escort),
        Role::Consort => Some(Role::Consort),
        Role::Mafioso | Role::Godfather | Role::Janitor => Some(Role::Mafioso),
        Role::Doctor => Some(Role::Doctor),
        Role::Detective => Some(Role::Detective),
        Role::Vigilante => Some(Role::Vigilante),
        Role::SerialKiller => Some(Role::SerialKiller),
        Role::Witch => Some(Role::Witch),
        // Roles without night actions don't wake up
        _ => None,
    }
}

/// Build the full night-phase narration script based on alive players and their roles.
/// Only includes wake-up steps for roles that are present and alive.
pub fn build_night_script(alive_players: &[(String, Role)]) -> Vec<NarrationStep> {
    let mut steps = Vec::new();

    // Opening: everyone close your eyes
    steps.push(NarrationStep {
        key: "night.everyone_close_eyes".into(),
        text: "Everyone, close your eyes.".into(),
        audio_file: "/audio/gm/night/everyone_close_eyes.mp3".into(),
        wait_for: WaitFor::Duration(3),
        target_role: None,
    });

    // Determine which wake-order slots have alive players
    for &wake_role in WAKE_ORDER {
        let has_role = alive_players.iter().any(|(_, r)| {
            canonical_wake_role(*r) == Some(wake_role)
        });
        if !has_role {
            continue;
        }

        let name = role_display_name(wake_role);
        let key_frag = role_key(wake_role);

        // "{Role} wakes up"
        steps.push(NarrationStep {
            key: format!("night.{key_frag}_wakes"),
            text: format!("The {name} wakes up."),
            audio_file: format!("/audio/gm/night/{key_frag}_wakes.mp3"),
            wait_for: WaitFor::Duration(2),
            target_role: Some(wake_role),
        });

        // Role-specific instruction — wait for player action
        steps.push(NarrationStep {
            key: format!("night.{key_frag}_instruction"),
            text: role_instruction(wake_role).into(),
            audio_file: format!("/audio/gm/night/{key_frag}_instruction.mp3"),
            wait_for: WaitFor::PlayerAction,
            target_role: Some(wake_role),
        });

        // "{Role} goes back to sleep"
        steps.push(NarrationStep {
            key: format!("night.{key_frag}_sleeps"),
            text: format!("The {name} goes back to sleep."),
            audio_file: format!("/audio/gm/night/{key_frag}_sleeps.mp3"),
            wait_for: WaitFor::Duration(2),
            target_role: Some(wake_role),
        });
    }

    steps
}

/// Build the dawn/day narration script.
/// `deaths` contains the names of players who died during the night.
pub fn build_dawn_script(deaths: &[String]) -> Vec<NarrationStep> {
    let mut steps = Vec::new();

    // "Everyone, open your eyes."
    steps.push(NarrationStep {
        key: "dawn.everyone_open_eyes".into(),
        text: "Everyone, open your eyes.".into(),
        audio_file: "/audio/gm/dawn/everyone_open_eyes.mp3".into(),
        wait_for: WaitFor::Duration(3),
        target_role: None,
    });

    // Death announcements (dynamic)
    if deaths.is_empty() {
        steps.push(NarrationStep {
            key: "dawn.no_deaths".into(),
            text: "The town sleeps peacefully. No one was killed last night.".into(),
            audio_file: "/audio/gm/dawn/no_deaths.mp3".into(),
            wait_for: WaitFor::Duration(3),
            target_role: None,
        });
    } else {
        // Generic "someone has been killed" — the TV shows names visually
        let count_text = if deaths.len() == 1 {
            "A body has been discovered.".to_string()
        } else {
            format!("{} bodies have been discovered.", deaths.len())
        };
        steps.push(NarrationStep {
            key: "dawn.death_announcement".into(),
            text: count_text,
            audio_file: "/audio/gm/dawn/death_announcement.mp3".into(),
            wait_for: WaitFor::HostAdvance,
            target_role: None,
        });
    }

    // "Time to discuss."
    steps.push(NarrationStep {
        key: "dawn.time_to_discuss".into(),
        text: "Time to discuss.".into(),
        audio_file: "/audio/gm/dawn/time_to_discuss.mp3".into(),
        wait_for: WaitFor::Duration(2),
        target_role: None,
    });

    steps
}

/// Build the voting phase narration script.
pub fn build_voting_script() -> Vec<NarrationStep> {
    let mut steps = Vec::new();

    steps.push(NarrationStep {
        key: "voting.time_to_vote".into(),
        text: "Time to vote.".into(),
        audio_file: "/audio/gm/voting/time_to_vote.mp3".into(),
        wait_for: WaitFor::Duration(2),
        target_role: None,
    });

    steps.push(NarrationStep {
        key: "voting.cast_votes".into(),
        text: "Cast your votes now.".into(),
        audio_file: "/audio/gm/voting/cast_votes.mp3".into(),
        wait_for: WaitFor::PlayerAction,
        target_role: None,
    });

    steps.push(NarrationStep {
        key: "voting.votes_are_in".into(),
        text: "The votes are in.".into(),
        audio_file: "/audio/gm/voting/votes_are_in.mp3".into(),
        wait_for: WaitFor::HostAdvance,
        target_role: None,
    });

    steps
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_night_script_opening_step() {
        let players = vec![
            ("p1".into(), Role::Civilian),
        ];
        let script = build_night_script(&players);
        assert_eq!(script[0].key, "night.everyone_close_eyes");
        assert_eq!(script[0].wait_for, WaitFor::Duration(3));
        assert!(script[0].target_role.is_none());
    }

    #[test]
    fn test_night_script_civilians_only() {
        // Only civilians — no night actions, so just the opening step
        let players = vec![
            ("p1".into(), Role::Civilian),
            ("p2".into(), Role::Civilian),
            ("p3".into(), Role::Mayor),
        ];
        let script = build_night_script(&players);
        assert_eq!(script.len(), 1); // only "everyone close your eyes"
    }

    #[test]
    fn test_night_script_single_role() {
        let players = vec![
            ("p1".into(), Role::Doctor),
            ("p2".into(), Role::Civilian),
        ];
        let script = build_night_script(&players);
        // 1 opening + 3 steps for Doctor (wake, instruction, sleep)
        assert_eq!(script.len(), 4);
        assert_eq!(script[1].key, "night.doctor_wakes");
        assert_eq!(script[1].target_role, Some(Role::Doctor));
        assert_eq!(script[2].key, "night.doctor_instruction");
        assert_eq!(script[2].wait_for, WaitFor::PlayerAction);
        assert_eq!(script[3].key, "night.doctor_sleeps");
    }

    #[test]
    fn test_night_script_wake_order() {
        let players = vec![
            ("p1".into(), Role::Detective),
            ("p2".into(), Role::Escort),
            ("p3".into(), Role::Mafioso),
            ("p4".into(), Role::Witch),
        ];
        let script = build_night_script(&players);

        // Extract wake keys in order
        let wake_keys: Vec<&str> = script.iter()
            .filter(|s| s.key.ends_with("_wakes"))
            .map(|s| s.key.as_str())
            .collect();

        assert_eq!(wake_keys, vec![
            "night.escort_wakes",
            "night.mafia_wakes",
            "night.detective_wakes",
            "night.witch_wakes",
        ]);
    }

    #[test]
    fn test_night_script_godfather_uses_mafia_slot() {
        let players = vec![
            ("p1".into(), Role::Godfather),
            ("p2".into(), Role::Doctor),
        ];
        let script = build_night_script(&players);

        let wake_keys: Vec<&str> = script.iter()
            .filter(|s| s.key.ends_with("_wakes"))
            .map(|s| s.key.as_str())
            .collect();

        // Mafia wakes before Doctor
        assert_eq!(wake_keys, vec!["night.mafia_wakes", "night.doctor_wakes"]);
    }

    #[test]
    fn test_night_script_no_duplicate_mafia_slot() {
        // Both Mafioso and Godfather alive — only one Mafia wake
        let players = vec![
            ("p1".into(), Role::Mafioso),
            ("p2".into(), Role::Godfather),
            ("p3".into(), Role::Janitor),
        ];
        let script = build_night_script(&players);

        let mafia_wakes: Vec<_> = script.iter()
            .filter(|s| s.key == "night.mafia_wakes")
            .collect();

        assert_eq!(mafia_wakes.len(), 1);
    }

    #[test]
    fn test_night_script_step_structure() {
        let players = vec![
            ("p1".into(), Role::SerialKiller),
        ];
        let script = build_night_script(&players);
        // opening + wake + instruction + sleep = 4
        assert_eq!(script.len(), 4);

        // Check audio file paths
        assert_eq!(script[1].audio_file, "/audio/gm/night/serial_killer_wakes.mp3");
        assert_eq!(script[2].audio_file, "/audio/gm/night/serial_killer_instruction.mp3");
        assert_eq!(script[3].audio_file, "/audio/gm/night/serial_killer_sleeps.mp3");
    }

    #[test]
    fn test_night_script_full_game() {
        let players = vec![
            ("p1".into(), Role::Escort),
            ("p2".into(), Role::Consort),
            ("p3".into(), Role::Mafioso),
            ("p4".into(), Role::Doctor),
            ("p5".into(), Role::Detective),
            ("p6".into(), Role::Vigilante),
            ("p7".into(), Role::SerialKiller),
            ("p8".into(), Role::Witch),
            ("p9".into(), Role::Civilian),
            ("p10".into(), Role::Godfather),
        ];
        let script = build_night_script(&players);

        // 1 opening + 8 roles * 3 steps each = 25
        assert_eq!(script.len(), 25);

        let wake_keys: Vec<&str> = script.iter()
            .filter(|s| s.key.ends_with("_wakes"))
            .map(|s| s.key.as_str())
            .collect();

        assert_eq!(wake_keys, vec![
            "night.escort_wakes",
            "night.consort_wakes",
            "night.mafia_wakes",
            "night.doctor_wakes",
            "night.detective_wakes",
            "night.vigilante_wakes",
            "night.serial_killer_wakes",
            "night.witch_wakes",
        ]);
    }

    #[test]
    fn test_dawn_script_no_deaths() {
        let script = build_dawn_script(&[]);
        assert_eq!(script.len(), 3); // open eyes + no deaths + discuss
        assert_eq!(script[0].key, "dawn.everyone_open_eyes");
        assert_eq!(script[1].key, "dawn.no_deaths");
        assert_eq!(script[2].key, "dawn.time_to_discuss");
    }

    #[test]
    fn test_dawn_script_with_deaths() {
        let deaths = vec!["Alice".into()];
        let script = build_dawn_script(&deaths);
        assert_eq!(script.len(), 3);
        assert_eq!(script[1].key, "dawn.death_announcement");
        assert!(script[1].text.contains("A body has been discovered"));
        assert_eq!(script[1].wait_for, WaitFor::HostAdvance);
    }

    #[test]
    fn test_dawn_script_multiple_deaths() {
        let deaths = vec!["Alice".into(), "Bob".into()];
        let script = build_dawn_script(&deaths);
        assert!(script[1].text.contains("2 bodies"));
    }

    #[test]
    fn test_voting_script() {
        let script = build_voting_script();
        assert_eq!(script.len(), 3);
        assert_eq!(script[0].key, "voting.time_to_vote");
        assert_eq!(script[1].key, "voting.cast_votes");
        assert_eq!(script[1].wait_for, WaitFor::PlayerAction);
        assert_eq!(script[2].key, "voting.votes_are_in");
        assert_eq!(script[2].wait_for, WaitFor::HostAdvance);
    }
}
