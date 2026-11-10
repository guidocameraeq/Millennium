// Millennium — mDNS meter (puesta-a-punto, encargo 01)
//
// Once a minute discovery reads the mdns-sd daemon metrics (cumulative
// counters) and logs what was sent and heard in that minute. This file is
// the pure part: two snapshots in, the log line out (or None when the
// minute was quiet). No daemon, no Tauri, so `displays-tests` tests it.
//
// What each counter is worth in mdns-sd 0.13.11 (service_daemon.rs lines,
// cited in the encargo 01 evidence):
//   - Queries (`browse` :2615, also on its own retries; `cache-refresh-*`
//     :2906-2908) and announces/goodbyes (`register` :2472, `unregister`
//     :2721) are counted once but go out on every enabled adapter (:1615-1630,
//     :1384-1408), so they are multiplied by the adapter count. In the
//     minute the adapter set changes, the goodbye on the old set is
//     multiplied by the NEW count (a small error either way).
//     `cache-refresh-addr` adds 2 per hostname for ONE packet (:2896-2897),
//     so it is halved.
//   - `respond` (:2396), `register-resend` (:2827) and `unregister-resend`
//     (:2734) are one packet each. 0.13.11 answers every query it hears,
//     even with an empty packet (:2392), so `respond` is also the number of
//     queries heard, our own looped-back ones included.
//   - NOT counted by the library: probe packets (`probing_handler`, :1439),
//     resolve queries for half-known peers (`query_unresolved`, :1704-1724,
//     at most 3 per peer) and every packet received. So `sent` is a MINIMUM.

use std::collections::HashMap;

/// Query counters: one packet per enabled adapter.
const QUERIES: [&str; 4] = ["browse", "resolve-hostname", "cache-refresh-ptr", "cache-refresh-srv-txt"];

fn delta(prev: &HashMap<String, i64>, now: &HashMap<String, i64>, key: &str) -> i64 {
    let a = prev.get(key).copied().unwrap_or(0);
    let b = now.get(key).copied().unwrap_or(0);
    (b - a).max(0)
}

/// What the daemon sent in one minute, in packets.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MinuteTraffic {
    /// Packets sent, at least (see the header): the number to watch.
    pub sent: i64,
    /// Response packets = queries heard (0.13 answers every query).
    pub responses: i64,
    /// Query packets (browse + cache refresh + hostname resolve).
    pub query_packets: i64,
    /// Announce / goodbye packets (register, unregister and their resends).
    pub announce_packets: i64,
    pub adapters: usize,
}

impl MinuteTraffic {
    /// The single log line.
    pub fn line(&self) -> String {
        format!(
            "[mdns] meter 60s: sent>={} packets on {} adapter(s) (responses {}, queries {}, announces {}); queries heard {} (own echo included; answers received not counted)",
            self.sent,
            self.adapters,
            self.responses,
            self.query_packets,
            self.announce_packets,
            self.responses
        )
    }
}

/// Traffic in the minute between `prev` and `now` (cumulative
/// `get_metrics` snapshots), or None if nothing was sent.
pub fn minute_report(
    prev: &HashMap<String, i64>,
    now: &HashMap<String, i64>,
    adapters: usize,
) -> Option<MinuteTraffic> {
    let d = |key: &str| delta(prev, now, key);
    let n = adapters as i64;
    let responses = d("respond");
    let query_ops: i64 = QUERIES.iter().map(|k| d(k)).sum::<i64>() + d("cache-refresh-addr") / 2;
    let query_packets = query_ops * n;
    let announce_packets =
        (d("register") + d("unregister")) * n + d("register-resend") + d("unregister-resend");
    let sent = responses + query_packets + announce_packets;
    if sent == 0 {
        return None;
    }
    Some(MinuteTraffic {
        sent,
        responses,
        query_packets,
        announce_packets,
        adapters,
    })
}
