// Millennium — mDNS meter (puesta-a-punto, encargo 01)
//
// Once a minute discovery reads the mdns-sd daemon metrics (cumulative
// counters) and logs what was sent and heard in that minute. This file is
// the pure part: two snapshots in, the log line out (or None when the
// minute was quiet). No daemon, no Tauri, so `displays-tests` tests it.
//
// mdns-sd 0.13 counts OPERATIONS, not packets: a query is counted once but
// goes out on every enabled adapter. So queries, announces and goodbyes are
// multiplied by the adapter count; `respond` is already one per packet. In
// 0.13 the daemon answers every query it hears (even with an empty packet),
// so `respond` is also the number of queries heard. Responses received are
// not counted by the daemon at all. It is an estimate: `cache-refresh-addr`
// counts 2 per hostname (A + AAAA) though both questions share one packet.

use std::collections::HashMap;

/// Counters that send one packet per enabled adapter.
const PER_ADAPTER: [&str; 7] = [
    "browse",
    "resolve-hostname",
    "cache-refresh-ptr",
    "cache-refresh-srv-txt",
    "cache-refresh-addr",
    "register",
    "unregister",
];

/// Counters that send one packet each.
const SINGLE: [&str; 3] = ["respond", "register-resend", "unregister-resend"];

fn delta(prev: &HashMap<String, i64>, now: &HashMap<String, i64>, key: &str) -> i64 {
    let a = prev.get(key).copied().unwrap_or(0);
    let b = now.get(key).copied().unwrap_or(0);
    (b - a).max(0)
}

/// What the daemon did in one minute.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MinuteTraffic {
    /// Estimated packets sent (operations x adapters, see the header).
    pub sent: i64,
    /// Responses sent = queries heard (0.13 answers every query).
    pub responses: i64,
    /// Query operations (browse + cache refresh + hostname resolve).
    pub queries: i64,
    /// Announce / goodbye operations (register, unregister and resends).
    pub announces: i64,
    pub adapters: usize,
}

impl MinuteTraffic {
    /// The single log line (the number to watch is `sent`).
    pub fn line(&self) -> String {
        format!(
            "[mdns] meter 60s: sent~{} packets on {} adapter(s) (responses {}, queries {}, announces {}); queries heard {}",
            self.sent, self.adapters, self.responses, self.queries, self.announces, self.responses
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
    let per_adapter: i64 = PER_ADAPTER.iter().map(|k| d(k)).sum();
    let single: i64 = SINGLE.iter().map(|k| d(k)).sum();
    if per_adapter + single == 0 {
        return None;
    }
    let responses = d("respond");
    let queries = d("browse")
        + d("resolve-hostname")
        + d("cache-refresh-ptr")
        + d("cache-refresh-srv-txt")
        + d("cache-refresh-addr");
    Some(MinuteTraffic {
        sent: per_adapter * adapters as i64 + single,
        responses,
        queries,
        announces: per_adapter - queries + single - responses,
        adapters,
    })
}
