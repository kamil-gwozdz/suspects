use serde::{Deserialize, Serialize};
use std::collections::HashMap;

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

// ---------------------------------------------------------------------------
// Prisoner's Dilemma
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PrisonerChoice {
    Cooperate,
    Betray,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PrisonerOutcome {
    pub player_id: String,
    pub choice: PrisonerChoice,
    pub score_delta: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PrisonersDilemmaResult {
    pub player_a: PrisonerOutcome,
    pub player_b: PrisonerOutcome,
}

/// Resolve a Prisoner's Dilemma between two players.
///
/// Both cooperate  → +2 each
/// One betrays     → betrayer +3, cooperator -1
/// Both betray     → -1 each
pub fn resolve_prisoners_dilemma(
    player_a_id: &str,
    choice_a: PrisonerChoice,
    player_b_id: &str,
    choice_b: PrisonerChoice,
) -> PrisonersDilemmaResult {
    let (delta_a, delta_b) = match (choice_a, choice_b) {
        (PrisonerChoice::Cooperate, PrisonerChoice::Cooperate) => (2, 2),
        (PrisonerChoice::Cooperate, PrisonerChoice::Betray) => (-1, 3),
        (PrisonerChoice::Betray, PrisonerChoice::Cooperate) => (3, -1),
        (PrisonerChoice::Betray, PrisonerChoice::Betray) => (-1, -1),
    };

    PrisonersDilemmaResult {
        player_a: PrisonerOutcome {
            player_id: player_a_id.to_string(),
            choice: choice_a,
            score_delta: delta_a,
        },
        player_b: PrisonerOutcome {
            player_id: player_b_id.to_string(),
            choice: choice_b,
            score_delta: delta_b,
        },
    }
}

/// Pick two distinct random indices from `alive_ids`.
/// Returns `None` if fewer than 2 players are alive.
pub fn pick_prisoner_pair(alive_ids: &[String]) -> Option<(String, String)> {
    if alive_ids.len() < 2 {
        return None;
    }
    use rand::Rng;
    let mut rng = rand::rng();
    let a = rng.random_range(0..alive_ids.len());
    let mut b = rng.random_range(0..alive_ids.len() - 1);
    if b >= a {
        b += 1;
    }
    Some((alive_ids[a].clone(), alive_ids[b].clone()))
}

// ---------------------------------------------------------------------------
// Trust Circle
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TrustRanking {
    pub ranker_id: String,
    /// Ordered list from most trusted (index 0, rank 1) to least trusted.
    pub ranked_player_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TrustScore {
    pub player_id: String,
    /// Lower is more trusted (1 = most trusted). This is the average rank.
    pub average_rank: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TrustCircleResult {
    pub scores: Vec<TrustScore>,
}

/// Aggregate trust rankings into average scores.
///
/// Each ranking assigns rank 1 (most trusted) through N (least) to the listed
/// players. The result contains per-player average rank sorted ascending
/// (most trusted first).
pub fn resolve_trust_circle(rankings: &[TrustRanking]) -> TrustCircleResult {
    let mut totals: HashMap<String, (f64, u32)> = HashMap::new();

    for ranking in rankings {
        for (idx, pid) in ranking.ranked_player_ids.iter().enumerate() {
            let rank = (idx + 1) as f64;
            let entry = totals.entry(pid.clone()).or_insert((0.0, 0));
            entry.0 += rank;
            entry.1 += 1;
        }
    }

    let mut scores: Vec<TrustScore> = totals
        .into_iter()
        .map(|(player_id, (sum, count))| TrustScore {
            player_id,
            average_rank: if count > 0 { sum / count as f64 } else { 0.0 },
        })
        .collect();

    scores.sort_by(|a, b| a.average_rank.partial_cmp(&b.average_rank).unwrap());

    TrustCircleResult { scores }
}

// ---------------------------------------------------------------------------
// Alibi Challenge
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AlibiVote {
    ThumbsUp,
    ThumbsDown,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AlibiChallengeResult {
    pub target_id: String,
    pub thumbs_up: u32,
    pub thumbs_down: u32,
    pub voters: Vec<AlibiVoterRecord>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AlibiVoterRecord {
    pub voter_id: String,
    pub vote: AlibiVote,
}

/// Pick a random spotlight target from the alive players.
pub fn pick_alibi_target(alive_ids: &[String]) -> Option<String> {
    if alive_ids.is_empty() {
        return None;
    }
    use rand::Rng;
    let mut rng = rand::rng();
    let idx = rng.random_range(0..alive_ids.len());
    Some(alive_ids[idx].clone())
}

/// Resolve alibi challenge votes.
pub fn resolve_alibi_challenge(
    target_id: &str,
    votes: &[(String, AlibiVote)],
) -> AlibiChallengeResult {
    let mut thumbs_up = 0u32;
    let mut thumbs_down = 0u32;
    let mut voters = Vec::new();

    for (voter_id, vote) in votes {
        match vote {
            AlibiVote::ThumbsUp => thumbs_up += 1,
            AlibiVote::ThumbsDown => thumbs_down += 1,
        }
        voters.push(AlibiVoterRecord {
            voter_id: voter_id.clone(),
            vote: *vote,
        });
    }

    AlibiChallengeResult {
        target_id: target_id.to_string(),
        thumbs_up,
        thumbs_down,
        voters,
    }
}

// ---------------------------------------------------------------------------
// Interrogation
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InterrogationQA {
    pub question: String,
    pub answer: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InterrogationResult {
    pub interrogator_id: String,
    pub target_id: String,
    pub qa_pairs: Vec<InterrogationQA>,
}

/// Build the interrogation result from collected Q&A pairs.
pub fn resolve_interrogation(
    interrogator_id: &str,
    target_id: &str,
    qa_pairs: Vec<InterrogationQA>,
) -> InterrogationResult {
    InterrogationResult {
        interrogator_id: interrogator_id.to_string(),
        target_id: target_id.to_string(),
        qa_pairs,
    }
}

/// Pick an interrogator. Prefers a player with the Detective role; falls back
/// to a random alive player. `detective_id` is `Some` when a living detective
/// exists.
pub fn pick_interrogator(
    detective_id: Option<&str>,
    alive_ids: &[String],
) -> Option<String> {
    if let Some(det) = detective_id {
        if alive_ids.iter().any(|id| id == det) {
            return Some(det.to_string());
        }
    }
    if alive_ids.is_empty() {
        return None;
    }
    use rand::Rng;
    let mut rng = rand::rng();
    let idx = rng.random_range(0..alive_ids.len());
    Some(alive_ids[idx].clone())
}

/// Pick an interrogation target (someone other than the interrogator).
pub fn pick_interrogation_target(
    interrogator_id: &str,
    alive_ids: &[String],
) -> Option<String> {
    let candidates: Vec<&String> = alive_ids
        .iter()
        .filter(|id| id.as_str() != interrogator_id)
        .collect();
    if candidates.is_empty() {
        return None;
    }
    use rand::Rng;
    let mut rng = rand::rng();
    let idx = rng.random_range(0..candidates.len());
    Some(candidates[idx].clone())
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    // --- Prisoner's Dilemma ---

    #[test]
    fn test_both_cooperate() {
        let r = resolve_prisoners_dilemma("a", PrisonerChoice::Cooperate, "b", PrisonerChoice::Cooperate);
        assert_eq!(r.player_a.score_delta, 2);
        assert_eq!(r.player_b.score_delta, 2);
    }

    #[test]
    fn test_both_betray() {
        let r = resolve_prisoners_dilemma("a", PrisonerChoice::Betray, "b", PrisonerChoice::Betray);
        assert_eq!(r.player_a.score_delta, -1);
        assert_eq!(r.player_b.score_delta, -1);
    }

    #[test]
    fn test_a_betrays_b_cooperates() {
        let r = resolve_prisoners_dilemma("a", PrisonerChoice::Betray, "b", PrisonerChoice::Cooperate);
        assert_eq!(r.player_a.score_delta, 3);
        assert_eq!(r.player_b.score_delta, -1);
    }

    #[test]
    fn test_a_cooperates_b_betrays() {
        let r = resolve_prisoners_dilemma("a", PrisonerChoice::Cooperate, "b", PrisonerChoice::Betray);
        assert_eq!(r.player_a.score_delta, -1);
        assert_eq!(r.player_b.score_delta, 3);
    }

    #[test]
    fn test_prisoner_pair_needs_two() {
        assert!(pick_prisoner_pair(&[]).is_none());
        assert!(pick_prisoner_pair(&["a".into()]).is_none());
        let pair = pick_prisoner_pair(&["a".into(), "b".into()]);
        assert!(pair.is_some());
        let (a, b) = pair.unwrap();
        assert_ne!(a, b);
    }

    // --- Trust Circle ---

    #[test]
    fn test_trust_circle_single_ranker() {
        let rankings = vec![TrustRanking {
            ranker_id: "r1".into(),
            ranked_player_ids: vec!["p1".into(), "p2".into(), "p3".into()],
        }];
        let result = resolve_trust_circle(&rankings);
        assert_eq!(result.scores.len(), 3);
        assert_eq!(result.scores[0].player_id, "p1");
        assert!((result.scores[0].average_rank - 1.0).abs() < f64::EPSILON);
        assert!((result.scores[1].average_rank - 2.0).abs() < f64::EPSILON);
        assert!((result.scores[2].average_rank - 3.0).abs() < f64::EPSILON);
    }

    #[test]
    fn test_trust_circle_multiple_rankers() {
        let rankings = vec![
            TrustRanking {
                ranker_id: "r1".into(),
                ranked_player_ids: vec!["p1".into(), "p2".into(), "p3".into()],
            },
            TrustRanking {
                ranker_id: "r2".into(),
                ranked_player_ids: vec!["p3".into(), "p1".into(), "p2".into()],
            },
        ];
        let result = resolve_trust_circle(&rankings);
        // p1: (1+2)/2 = 1.5, p2: (2+3)/2 = 2.5, p3: (3+1)/2 = 2.0
        let find = |id: &str| result.scores.iter().find(|s| s.player_id == id).unwrap();
        assert!((find("p1").average_rank - 1.5).abs() < f64::EPSILON);
        assert!((find("p3").average_rank - 2.0).abs() < f64::EPSILON);
        assert!((find("p2").average_rank - 2.5).abs() < f64::EPSILON);
        // Sorted ascending
        assert_eq!(result.scores[0].player_id, "p1");
    }

    #[test]
    fn test_trust_circle_empty() {
        let result = resolve_trust_circle(&[]);
        assert!(result.scores.is_empty());
    }

    // --- Alibi Challenge ---

    #[test]
    fn test_alibi_all_thumbs_up() {
        let votes = vec![
            ("v1".into(), AlibiVote::ThumbsUp),
            ("v2".into(), AlibiVote::ThumbsUp),
        ];
        let result = resolve_alibi_challenge("target", &votes);
        assert_eq!(result.thumbs_up, 2);
        assert_eq!(result.thumbs_down, 0);
        assert_eq!(result.target_id, "target");
    }

    #[test]
    fn test_alibi_mixed_votes() {
        let votes = vec![
            ("v1".into(), AlibiVote::ThumbsUp),
            ("v2".into(), AlibiVote::ThumbsDown),
            ("v3".into(), AlibiVote::ThumbsDown),
        ];
        let result = resolve_alibi_challenge("t1", &votes);
        assert_eq!(result.thumbs_up, 1);
        assert_eq!(result.thumbs_down, 2);
        assert_eq!(result.voters.len(), 3);
    }

    #[test]
    fn test_alibi_no_votes() {
        let result = resolve_alibi_challenge("t1", &[]);
        assert_eq!(result.thumbs_up, 0);
        assert_eq!(result.thumbs_down, 0);
    }

    #[test]
    fn test_pick_alibi_target_empty() {
        assert!(pick_alibi_target(&[]).is_none());
    }

    #[test]
    fn test_pick_alibi_target_single() {
        let t = pick_alibi_target(&["p1".into()]);
        assert_eq!(t.unwrap(), "p1");
    }

    // --- Interrogation ---

    #[test]
    fn test_interrogation_result() {
        let qa = vec![
            InterrogationQA { question: "Are you mafia?".into(), answer: false },
            InterrogationQA { question: "Did you act last night?".into(), answer: true },
            InterrogationQA { question: "Are you town?".into(), answer: true },
        ];
        let result = resolve_interrogation("det", "sus", qa);
        assert_eq!(result.interrogator_id, "det");
        assert_eq!(result.target_id, "sus");
        assert_eq!(result.qa_pairs.len(), 3);
        assert!(!result.qa_pairs[0].answer);
        assert!(result.qa_pairs[1].answer);
    }

    #[test]
    fn test_pick_interrogator_with_detective() {
        let alive = vec!["p1".into(), "det".into(), "p2".into()];
        let result = pick_interrogator(Some("det"), &alive);
        assert_eq!(result.unwrap(), "det");
    }

    #[test]
    fn test_pick_interrogator_detective_dead_falls_back() {
        let alive = vec!["p1".into(), "p2".into()];
        let result = pick_interrogator(Some("det"), &alive);
        assert!(result.is_some());
        assert!(alive.contains(&result.unwrap()));
    }

    #[test]
    fn test_pick_interrogator_no_detective() {
        let alive = vec!["p1".into(), "p2".into()];
        let result = pick_interrogator(None, &alive);
        assert!(result.is_some());
    }

    #[test]
    fn test_pick_interrogation_target() {
        let alive = vec!["det".into(), "p1".into(), "p2".into()];
        let target = pick_interrogation_target("det", &alive);
        assert!(target.is_some());
        assert_ne!(target.unwrap(), "det");
    }

    #[test]
    fn test_pick_interrogation_target_only_interrogator() {
        let alive = vec!["det".into()];
        assert!(pick_interrogation_target("det", &alive).is_none());
    }
}
