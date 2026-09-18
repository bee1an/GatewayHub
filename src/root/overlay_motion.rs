//! Deterministic sampling for the overlay card's layered motion —
//! "底板先浮起，信息随后清晰"（surface rises, then the content group
//! clarifies). Every channel is a pure function of elapsed milliseconds
//! so tests can assert exact values without sleeping.
//!
//! Ported from Heimdall's `confirm_motion.rs`. Easing: enter
//! `E(u) = 1-(1-u)³`, exit `X(u) = u²` — no overshoot.

/// One instant of the overlay's layered motion. Alphas are FINAL
/// effective values (panel surface and content are siblings, never
/// multiplied through a parent opacity); offsets are in rem so they
/// follow the user's UI scale.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct OverlayMotion {
    /// Backdrop dim — peaks at 0.5.
    pub backdrop_a: f32,
    /// Panel surface visibility (bg + border + shadow fade together).
    pub panel_a: f32,
    /// Panel vertical offset: +0.625rem → 0 opening; sinks +0.25rem closing.
    pub panel_off_rem: f32,
    /// Content-group visibility (title, body, footer — one curve).
    pub content_a: f32,
    /// Content-group offset relative to the panel: +0.1875rem → 0 opening;
    /// frozen at the sampled value while closing.
    pub content_off_rem: f32,
}

/// Open: the last channel (content) lands at 220ms.
pub(crate) const OPEN_MS: f32 = 220.;
/// Close: everything gone by 130ms.
pub(crate) const CLOSE_MS: f32 = 130.;
const BACKDROP_MAX: f32 = 0.5;
/// Panel rise distance — 10px at the default 16px rem.
const PANEL_RISE_REM: f32 = 0.625;
/// Content micro-rise relative to the panel — 3px at 16px rem.
const CONTENT_RISE_REM: f32 = 0.1875;
/// Panel sink on exit — 4px at 16px rem.
const PANEL_SINK_REM: f32 = 0.25;

fn e(u: f32) -> f32 {
    1. - (1. - u.clamp(0., 1.)).powi(3)
}

fn x(u: f32) -> f32 {
    let u = u.clamp(0., 1.);
    u * u
}

fn u_at(elapsed_ms: f32, delay: f32, dur: f32) -> f32 {
    ((elapsed_ms - delay) / dur).clamp(0., 1.)
}

/// Steady open state — also what `reduce_motion` renders every frame.
pub(crate) fn steady() -> OverlayMotion {
    OverlayMotion {
        backdrop_a: BACKDROP_MAX,
        panel_a: 1.,
        panel_off_rem: 0.,
        content_a: 1.,
        content_off_rem: 0.,
    }
}

/// Sample the opening animation `elapsed_ms` after the request landed.
pub(crate) fn open_at(elapsed_ms: f32) -> OverlayMotion {
    let panel_e = e(u_at(elapsed_ms, 0., 180.));
    let content_e = e(u_at(elapsed_ms, 35., 185.));
    OverlayMotion {
        backdrop_a: BACKDROP_MAX * e(u_at(elapsed_ms, 0., 100.)),
        panel_a: panel_e,
        panel_off_rem: PANEL_RISE_REM * (1. - panel_e),
        content_a: content_e,
        content_off_rem: CONTENT_RISE_REM * (1. - content_e),
    }
}

/// Exit from the sampled open values — the first closing frame is
/// continuous with whatever was on screen, never a snap to a schedule.
pub(crate) fn close_at(sample: OverlayMotion, elapsed_ms: f32) -> OverlayMotion {
    OverlayMotion {
        backdrop_a: sample.backdrop_a * (1. - x(u_at(elapsed_ms, 0., 130.))),
        panel_a: sample.panel_a * (1. - x(u_at(elapsed_ms, 15., 115.))),
        panel_off_rem: sample.panel_off_rem + PANEL_SINK_REM * x(u_at(elapsed_ms, 0., 130.)),
        content_a: sample.content_a * (1. - x(u_at(elapsed_ms, 0., 90.))),
        content_off_rem: sample.content_off_rem,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn open_boundaries() {
        let m0 = open_at(0.);
        assert_eq!(m0.backdrop_a, 0.);
        assert_eq!(m0.panel_a, 0.);
        assert_eq!(m0.panel_off_rem, PANEL_RISE_REM);
        assert_eq!(m0.content_a, 0.);

        // Content is still fully hidden before its 35ms delay elapses.
        assert_eq!(open_at(30.).content_a, 0.);
        assert!(open_at(40.).content_a > 0.);

        // Backdrop finishes at 100ms; panel at 180; everything by 220.
        assert_eq!(open_at(100.).backdrop_a, BACKDROP_MAX);
        let end = open_at(220.);
        assert_eq!(end, steady());
        assert_eq!(open_at(1000.), steady());
    }

    #[test]
    fn open_is_monotonic_and_bounded() {
        // No overshoot: every channel stays within [0, final].
        let mut prev = open_at(0.);
        for ms in (1..=220).map(|v| v as f32) {
            let m = open_at(ms);
            assert!(m.backdrop_a >= prev.backdrop_a && m.backdrop_a <= BACKDROP_MAX);
            assert!(m.panel_a >= prev.panel_a && m.panel_a <= 1.);
            assert!(m.panel_off_rem <= prev.panel_off_rem && m.panel_off_rem >= 0.);
            assert!(m.content_a >= prev.content_a && m.content_a <= 1.);
            assert!(m.content_off_rem <= prev.content_off_rem && m.content_off_rem >= 0.);
            prev = m;
        }
    }

    #[test]
    fn close_is_continuous_with_the_sample() {
        // Dismissed mid-open (20/80/180ms): frame 1 of the exit ≈ sample.
        for open_ms in [20., 80., 180., 220.] {
            let sample = open_at(open_ms);
            let first = close_at(sample, 0.);
            assert_eq!(first.backdrop_a, sample.backdrop_a);
            assert_eq!(first.panel_a, sample.panel_a);
            assert_eq!(first.content_a, sample.content_a);
            assert_eq!(first.panel_off_rem, sample.panel_off_rem);
            assert_eq!(first.content_off_rem, sample.content_off_rem);

            // Monotonic fade to zero; panel only sinks deeper.
            let mut prev = first;
            for ms in (1..=130).map(|v| v as f32) {
                let m = close_at(sample, ms);
                assert!(m.content_a <= prev.content_a + f32::EPSILON);
                assert!(m.backdrop_a <= prev.backdrop_a + f32::EPSILON);
                assert!(m.panel_off_rem >= prev.panel_off_rem - f32::EPSILON);
                prev = m;
            }
            let end = close_at(sample, 130.);
            assert_eq!(end.backdrop_a, 0.);
            assert_eq!(end.panel_a, 0.);
            assert_eq!(end.content_a, 0.);
            assert_eq!(end.panel_off_rem, sample.panel_off_rem + PANEL_SINK_REM);
        }
    }

    #[test]
    fn steady_state_is_idempotent() {
        // reduce-motion path: every sampled time is the final frame and a
        // close from it still animates from full visibility.
        let s = steady();
        assert_eq!(open_at(OPEN_MS), s);
        let closing = close_at(s, CLOSE_MS / 2.);
        assert!(closing.content_a < 1. && closing.content_a > 0.);
    }
}
