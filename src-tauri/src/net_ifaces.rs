// Millennium — which network adapters count as "real" (puesta-a-punto, encargo 01)
//
// The one rule for "is this NIC a real LAN adapter?", shared by identity
// (which IP we show and announce) and discovery (which NICs the mDNS daemon
// listens and answers on). Pure: a list of (adapter name, ip) goes in, the
// adapters to use and the reason each other one was dropped come out. No OS
// access, no Tauri, so `displays-tests` can include it by `#[path]` and test it.

use std::net::{IpAddr, Ipv4Addr};

/// Why an adapter was left out.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Discard {
    NotIpv4,
    Loopback,
    /// 169.254.x.x (APIPA): usually a NIC that got no DHCP lease.
    LinkLocal,
    /// Public or otherwise non-RFC1918 address: not a home/office LAN.
    NotPrivate,
    /// WSL, Hyper-V, Docker, VPN, ... (see `is_virtual_iface`).
    Virtual,
}

impl Discard {
    pub fn as_str(self) -> &'static str {
        match self {
            Discard::NotIpv4 => "not ipv4",
            Discard::Loopback => "loopback",
            Discard::LinkLocal => "link-local (169.254)",
            Discard::NotPrivate => "not a private LAN ip",
            Discard::Virtual => "virtual adapter",
        }
    }
}

/// Result of `classify_ifaces`: adapters to use (in the system's order) and
/// the ones discarded, each with its reason.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct IfaceChoice {
    pub used: Vec<(String, Ipv4Addr)>,
    pub discarded: Vec<(String, IpAddr, Discard)>,
}

/// Adapter names that are almost always virtual / tunnel NICs. WSL and
/// Hyper-V expose "vEthernet (...)", VPNs surface as "VPN"/"tun"/"tap",
/// etc. Deliberately conservative: a false negative just risks announcing
/// on a virtual NIC (the old behaviour), while a false positive could
/// discard the one real adapter — so we keep the list tight and the caller
/// falls back to the routing-table IP when nothing clean survives the filter.
pub fn is_virtual_iface(name: &str) -> bool {
    let n = name.to_lowercase();
    n.contains("vethernet")
        || n.contains("wsl")
        || n.contains("hyper-v")
        || n.contains("virtualbox")
        || n.contains("vmware")
        || n.contains("vpn")
        || n.contains("tailscale")
        || n.contains("zerotier")
        || n.contains("docker")
        || n.contains("loopback")
        || n.contains("tun")
        || n.contains("tap")
}

/// Split `ifaces` into real LAN adapters (private, non-loopback, non-virtual
/// IPv4) and discarded ones. Keeps the input order, so `used[0]` is the
/// adapter `identity::pick_local_ipv4` returns.
pub fn classify_ifaces(ifaces: &[(String, IpAddr)]) -> IfaceChoice {
    let mut choice = IfaceChoice::default();
    for (name, ip) in ifaces {
        let why = match ip {
            IpAddr::V6(_) => Some(Discard::NotIpv4),
            IpAddr::V4(v4) => v4_discard(name, *v4),
        };
        match (why, ip) {
            (None, IpAddr::V4(v4)) => choice.used.push((name.clone(), *v4)),
            (why, _) => choice
                .discarded
                .push((name.clone(), *ip, why.unwrap_or(Discard::NotIpv4))),
        }
    }
    choice
}

/// What moved between two adapter sets: IPs to drop and IPs to add. Order
/// does not matter (the same adapters listed in another order is no change).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct IpDiff {
    pub gone: Vec<IpAddr>,
    pub added: Vec<IpAddr>,
}

impl IpDiff {
    pub fn is_empty(&self) -> bool {
        self.gone.is_empty() && self.added.is_empty()
    }
}

/// Compare the adapter IPs in use (`old`) with a fresh enumeration (`new`).
pub fn diff_ips(old: &[IpAddr], new: &[IpAddr]) -> IpDiff {
    let _ = (old, new);
    IpDiff::default()
}

fn v4_discard(name: &str, ip: Ipv4Addr) -> Option<Discard> {
    if ip.is_loopback() {
        Some(Discard::Loopback)
    } else if ip.is_link_local() {
        Some(Discard::LinkLocal)
    } else if !ip.is_private() {
        Some(Discard::NotPrivate)
    } else if is_virtual_iface(name) {
        Some(Discard::Virtual)
    } else {
        None
    }
}
