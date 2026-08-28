//! Ephemeral per-user "rich presence" — what a member is playing or
//! listening to outside Tupi. Sibling of the presence registry: held
//! in memory on the `Hub`, never persisted, rebuilt empty on restart
//! (canon §6). Spec: SDD/specs/activity.md.

use std::collections::HashMap;

use uuid::Uuid;

use super::protocol::{Activity, ActivityEntry};

const MAX_ACTIVITIES: usize = 4;
const MAX_NAME: usize = 128;
const MAX_TEXT: usize = 256;
const MAX_ASSET_IMAGE: usize = 512;
const MAX_STARTED_AT: usize = 64;

const ALLOWED_KINDS: [&str; 4] = ["playing", "listening", "watching", "browsing"];

#[derive(Default)]
pub struct ActivityRegistry {
    by_user: HashMap<Uuid, Vec<Activity>>,
}

impl ActivityRegistry {
    /// Clamp a client-reported list into something safe to broadcast
    /// (ACT-FR-003): cap the list, drop items with an unknown `kind` or an
    /// empty `name`, truncate over-long strings. Returns the sanitized list
    /// plus how many raw items it could not keep (for a telemetry `warn`).
    pub fn sanitize(raw: Vec<Activity>) -> (Vec<Activity>, usize) {
        let raw_len = raw.len();
        let mut out: Vec<Activity> = Vec::with_capacity(raw_len.min(MAX_ACTIVITIES));
        for mut activity in raw.into_iter() {
            if out.len() >= MAX_ACTIVITIES {
                break;
            }
            if !ALLOWED_KINDS.contains(&activity.kind.as_str()) {
                continue;
            }
            activity.name = truncate(activity.name.trim(), MAX_NAME);
            if activity.name.is_empty() {
                continue;
            }
            activity.details = clamp_opt(activity.details, MAX_TEXT);
            activity.state = clamp_opt(activity.state, MAX_TEXT);
            activity.asset_text = clamp_opt(activity.asset_text, MAX_TEXT);
            activity.asset_image = clamp_opt(activity.asset_image, MAX_ASSET_IMAGE);
            activity.started_at = clamp_opt(activity.started_at, MAX_STARTED_AT);
            // Server-derived fields are never trusted from the client — the
            // aggregate step (ACT-FR-032) fills them for outbound events.
            activity.total_seconds = None;
            activity.last_played_at = None;
            activity.is_new = None;
            out.push(activity);
        }
        let dropped = raw_len.saturating_sub(out.len());
        (out, dropped)
    }

    /// Replace a user's activity list. Returns true iff it actually changed
    /// (drives the dedupe in ACT-FR-004 — a re-observed identical state does
    /// not re-broadcast).
    pub fn set(&mut self, user_id: Uuid, activities: Vec<Activity>) -> bool {
        if activities.is_empty() {
            return self.by_user.remove(&user_id).is_some();
        }
        match self.by_user.get(&user_id) {
            Some(existing) if *existing == activities => false,
            _ => {
                self.by_user.insert(user_id, activities);
                true
            }
        }
    }

    /// Drop a user's activity entirely. Returns true if there was something.
    pub fn clear(&mut self, user_id: Uuid) -> bool {
        self.by_user.remove(&user_id).is_some()
    }

    pub fn get(&self, user_id: Uuid) -> Vec<Activity> {
        self.by_user.get(&user_id).cloned().unwrap_or_default()
    }

    /// Snapshot restricted to `member_ids`, omitting anyone with no activity
    /// (ACT-FR-005 — the client assumes an empty list for any absent id).
    pub fn snapshot_for(&self, member_ids: &[Uuid]) -> Vec<ActivityEntry> {
        member_ids
            .iter()
            .filter_map(|id| {
                self.by_user.get(id).map(|activities| ActivityEntry {
                    user_id: *id,
                    activities: activities.clone(),
                })
            })
            .collect()
    }
}

fn truncate(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_string()
    } else {
        s.chars().take(max).collect()
    }
}

fn clamp_opt(value: Option<String>, max: usize) -> Option<String> {
    match value {
        Some(s) => {
            let trimmed = s.trim();
            if trimmed.is_empty() {
                None
            } else {
                Some(truncate(trimmed, max))
            }
        }
        None => None,
    }
}

/// Stable identity for a `kind == "playing"` activity, used to accumulate
/// playtime across sessions (ACT-FR-030). A Steam asset ref pins the exact
/// title; otherwise the lowercased name is the best we have.
pub fn game_key(activity: &Activity) -> Option<String> {
    if activity.kind != "playing" {
        return None;
    }
    match activity.asset_image.as_deref() {
        Some(reference) if reference.starts_with("steam:") => Some(reference.to_string()),
        _ => Some(format!("name:{}", activity.name.trim().to_lowercase())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn activity(kind: &str, name: &str) -> Activity {
        Activity {
            kind: kind.to_string(),
            name: name.to_string(),
            details: None,
            state: None,
            started_at: None,
            asset_image: None,
            asset_text: None,
            total_seconds: None,
            last_played_at: None,
            is_new: None,
        }
    }

    #[test]
    fn game_key_prefers_steam_ref_then_falls_back_to_name() {
        let mut steam = activity("playing", "Rocket League");
        steam.asset_image = Some("steam:252950".to_string());
        assert_eq!(game_key(&steam).as_deref(), Some("steam:252950"));

        let plain = activity("playing", "  Factorio  ");
        assert_eq!(game_key(&plain).as_deref(), Some("name:factorio"));

        assert_eq!(game_key(&activity("listening", "Spotify")), None);
    }

    #[test]
    fn sanitize_caps_list_and_drops_invalid_kind() {
        let raw = vec![
            activity("playing", "A"),
            activity("listening", "B"),
            activity("bogus", "C"),
            activity("watching", "D"),
            activity("browsing", "E"),
            activity("playing", "F"),
        ];
        let (out, dropped) = ActivityRegistry::sanitize(raw);
        assert_eq!(out.len(), 4);
        assert_eq!(dropped, 2);
        assert!(out.iter().all(|a| a.name != "C"));
    }

    #[test]
    fn sanitize_drops_empty_name_and_trims_asset_image_len() {
        let mut over = activity("playing", "  Game  ");
        over.asset_image = Some("x".repeat(MAX_ASSET_IMAGE + 50));
        over.details = Some("   ".to_string());
        let (out, _) = ActivityRegistry::sanitize(vec![over, activity("playing", "   ")]);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].name, "Game");
        assert_eq!(out[0].details, None);
        assert_eq!(out[0].asset_image.as_ref().unwrap().chars().count(), MAX_ASSET_IMAGE);
    }

    #[test]
    fn set_reports_change_only_on_difference() {
        let mut reg = ActivityRegistry::default();
        let user = Uuid::new_v4();
        assert!(reg.set(user, vec![activity("playing", "A")]));
        assert!(!reg.set(user, vec![activity("playing", "A")]));
        assert!(reg.set(user, vec![activity("playing", "B")]));
        assert!(reg.set(user, vec![]));
        assert!(!reg.set(user, vec![]));
    }

    #[test]
    fn snapshot_omits_members_without_activity() {
        let mut reg = ActivityRegistry::default();
        let a = Uuid::new_v4();
        let b = Uuid::new_v4();
        reg.set(a, vec![activity("listening", "Spotify")]);
        let snap = reg.snapshot_for(&[a, b]);
        assert_eq!(snap.len(), 1);
        assert_eq!(snap[0].user_id, a);
    }
}
