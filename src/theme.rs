//! GatewayHub's warm, low-contrast desktop palette.
//!
//! These values mirror the Electron application's semantic tokens.  The
//! window itself stays opaque: GPUI's live blur is substantially more
//! expensive while scrolling long virtualized lists and did not materially
//! improve the appearance of the existing mostly-opaque surfaces.

use gpui_kit::component::{Theme, ThemeConfig, ThemeMode, ThemeRegistry};
use gpui_kit::{App, WindowAppearance};
use std::rc::Rc;

pub(crate) fn apply_brand_tokens(cfg: &mut ThemeConfig, dark: bool) {
    cfg.radius = Some(8);
    cfg.radius_lg = Some(12);
    cfg.shadow = Some(false);
    let c = &mut cfg.colors;
    let secondary_text = if dark { "#8f8c82" } else { "#5a5852" };
    if dark {
        c.background = Some("#1a1917".into());
        c.foreground = Some("#ecebe6".into());
        c.muted = Some("#22211d".into());
        c.muted_foreground = Some(secondary_text.into());
        c.border = Some("#35342f".into());
        // `input` is the field border token (bg comes from input_background
        // = input@30% on dark). Same hue as `border` so fields are visible
        // against group_box cards.
        c.input = Some("#35342f".into());
        c.ring = Some("#c08532".into());
        c.caret = Some("#ecebe6".into());
        c.sidebar = Some("#1a1917".into());
        c.sidebar_foreground = Some("#ecebe6".into());
        c.sidebar_border = Some("#26251f".into());
        c.sidebar_accent = Some("#26251f".into());
        c.sidebar_primary = Some("#c08532".into());
        c.sidebar_primary_foreground = Some("#1f1f21".into());
        c.group_box = Some("#1e1d1a".into());
        c.group_box_foreground = Some("#ecebe6".into());
        c.group_box_title_foreground = Some(secondary_text.into());
        c.list = Some("#00000000".into());
        c.list_head = Some("#22211d".into());
        c.list_even = Some("#1e1d1a".into());
        c.list_hover = Some("#ffffff0a".into());
        c.list_active = Some("#c0853236".into());
        c.list_active_border = Some("#35342f".into());
        c.accent = Some("#ffffff0d".into());
        c.accent_foreground = Some("#ecebe6".into());
        c.primary = Some("#c08532".into());
        c.primary_foreground = Some("#1f1f21".into());
        c.primary_hover = Some("#d09548".into());
        c.primary_active = Some("#a8722a".into());
        c.secondary = Some("#26251f".into());
        c.secondary_foreground = Some("#cfccc2".into());
        c.secondary_hover = Some("#35342f".into());
        c.secondary_active = Some("#3e3d37".into());
        c.button = Some("#26251f".into());
        c.button_foreground = Some("#ecebe6".into());
        c.button_hover = Some("#35342f".into());
        c.button_active = Some("#3e3d37".into());
        c.button_primary = Some("#c08532".into());
        c.button_primary_foreground = Some("#1f1f21".into());
        c.button_primary_hover = Some("#d09548".into());
        c.button_primary_active = Some("#a8722a".into());
        c.button_secondary = Some("#26251f".into());
        c.button_secondary_foreground = Some("#ecebe6".into());
        c.button_secondary_hover = Some("#35342f".into());
        c.button_secondary_active = Some("#3e3d37".into());
        c.popover = Some("#22211d".into());
        c.popover_foreground = Some("#ecebe6".into());
        c.title_bar = Some("#00000000".into());
        c.title_bar_border = Some("#ffffff12".into());
        c.tab_bar = Some("#1e1d1a".into());
        c.tab = Some("#1e1d1a".into());
        c.tab_foreground = Some(secondary_text.into());
        c.tab_active = Some("#26251f".into());
        c.tab_active_foreground = Some("#ecebe6".into());
        c.tab_bar_segmented = Some("#22211d".into());
        c.table = Some("#00000000".into());
        c.table_head = Some("#22211d".into());
        c.table_head_foreground = Some(secondary_text.into());
        c.table_row_border = Some("#2b2a25".into());
        c.table_even = Some("#1e1d1a".into());
        c.table_hover = Some("#ffffff0a".into());
        c.table_active = Some("#c0853236".into());
        c.table_active_border = Some("#35342f".into());
        c.table_foot = Some("#22211d".into());
        c.table_foot_foreground = Some(secondary_text.into());
        c.scrollbar = Some("#00000000".into());
        c.scrollbar_thumb = Some("#55534c66".into());
        c.scrollbar_thumb_hover = Some("#8f8c8280".into());
        c.slider_bar = Some("#35342f".into());
        c.slider_thumb = Some("#ecebe6".into());
        c.switch = Some("#35342f".into());
        c.switch_thumb = Some("#ecebe6".into());
        c.selection = Some("#c0853259".into());
        c.link = Some("#d09548".into());
        c.link_hover = Some("#e0a55c".into());
        c.link_active = Some("#c08532".into());
        c.progress_bar = Some("#c08532".into());
        c.skeleton = Some("#ffffff0f".into());
        c.accordion = Some("#1e1d1a".into());
        c.description_list_label = Some("#22211d".into());
        c.description_list_label_foreground = Some(secondary_text.into());
        c.drag_border = Some("#ffffff1f".into());
        c.drop_target = Some("#c08532".into());
        c.tiles = Some("#1e1d1a".into());
        c.info = Some("#a3a3a8".into());
        c.info_foreground = Some("#1f1f21".into());
        c.info_hover = Some("#b8b8be".into());
        c.info_active = Some("#a3a3a8".into());
        c.window_border = Some("#35342f".into());
    } else {
        c.background = Some("#f3f3f1".into());
        c.foreground = Some("#26251e".into());
        c.muted = Some("#e9e9e5".into());
        c.muted_foreground = Some(secondary_text.into());
        c.border = Some("#00000018".into());
        c.input = Some("#00000018".into());
        c.ring = Some("#a8722a".into());
        c.caret = Some("#26251e".into());
        c.sidebar = Some("#e9e9e6".into());
        c.sidebar_foreground = Some("#26251e".into());
        c.sidebar_border = Some("#d9d9d5".into());
        c.sidebar_accent = Some("#f5f5f2".into());
        c.sidebar_primary = Some("#a8722a".into());
        c.sidebar_primary_foreground = Some("#ffffff".into());
        c.group_box = Some("#fbfbfa".into());
        c.group_box_foreground = Some("#26251e".into());
        c.group_box_title_foreground = Some(secondary_text.into());
        c.list = Some("#00000000".into());
        c.list_head = Some("#e9e9e5".into());
        c.list_even = Some("#fbfbfa".into());
        c.list_hover = Some("#00000008".into());
        c.list_active = Some("#a8722a30".into());
        c.list_active_border = Some("#00000014".into());
        c.accent = Some("#00000008".into());
        c.accent_foreground = Some("#26251e".into());
        c.primary = Some("#a8722a".into());
        c.primary_foreground = Some("#ffffff".into());
        c.primary_hover = Some("#c08532".into());
        c.primary_active = Some("#8c5f22".into());
        c.secondary = Some("#e9e9e5".into());
        c.secondary_foreground = Some("#3a392f".into());
        c.secondary_hover = Some("#e6e5e0".into());
        c.secondary_active = Some("#d8d6cf".into());
        c.button = Some("#e9e9e5".into());
        c.button_foreground = Some("#26251e".into());
        c.button_hover = Some("#e6e5e0".into());
        c.button_active = Some("#d8d6cf".into());
        c.button_primary = Some("#a8722a".into());
        c.button_primary_foreground = Some("#ffffff".into());
        c.button_primary_hover = Some("#c08532".into());
        c.button_primary_active = Some("#8c5f22".into());
        c.button_secondary = Some("#e9e9e5".into());
        c.button_secondary_foreground = Some("#26251e".into());
        c.button_secondary_hover = Some("#e6e5e0".into());
        c.button_secondary_active = Some("#d8d6cf".into());
        c.popover = Some("#ffffff".into());
        c.popover_foreground = Some("#26251e".into());
        c.title_bar = Some("#00000000".into());
        c.title_bar_border = Some("#00000010".into());
        c.tab_bar = Some("#e9e9e5".into());
        c.tab = Some("#e9e9e5".into());
        c.tab_foreground = Some(secondary_text.into());
        c.tab_active = Some("#ffffff".into());
        c.tab_active_foreground = Some("#26251e".into());
        c.tab_bar_segmented = Some("#e9e9e5".into());
        c.table = Some("#00000000".into());
        c.table_head = Some("#e9e9e5".into());
        c.table_head_foreground = Some(secondary_text.into());
        c.table_row_border = Some("#00000014".into());
        c.table_even = Some("#fbfbfa".into());
        c.table_hover = Some("#00000008".into());
        c.table_active = Some("#a8722a30".into());
        c.table_active_border = Some("#00000014".into());
        c.table_foot = Some("#e9e9e5".into());
        c.table_foot_foreground = Some(secondary_text.into());
        c.scrollbar = Some("#00000000".into());
        c.scrollbar_thumb = Some("#0000001f".into());
        c.scrollbar_thumb_hover = Some("#00000033".into());
        c.slider_bar = Some("#d1d1d6".into());
        c.slider_thumb = Some("#1d1d1f".into());
        c.switch = Some("#d1d1d6".into());
        c.switch_thumb = Some("#1d1d1f".into());
        c.selection = Some("#a8722a3d".into());
        c.link = Some("#a8722a".into());
        c.link_hover = Some("#c08532".into());
        c.link_active = Some("#8c5f22".into());
        c.progress_bar = Some("#a8722a".into());
        c.skeleton = Some("#0000000a".into());
        c.accordion = Some("#fbfbfa".into());
        c.description_list_label = Some("#e9e9e5".into());
        c.description_list_label_foreground = Some(secondary_text.into());
        c.drag_border = Some("#00000014".into());
        c.drop_target = Some("#a8722a".into());
        c.tiles = Some("#fbfbfa".into());
        c.info = Some("#636368".into());
        c.info_foreground = Some("#ffffff".into());
        c.info_hover = Some("#515156".into());
        c.info_active = Some("#636368".into());
        c.window_border = Some("#d2d2ce".into());
    }
}

pub(crate) fn restore_default_themes(cx: &mut App) {
    let (mut light, mut dark) = {
        let registry = ThemeRegistry::global(cx);
        (
            (**registry.default_light_theme()).clone(),
            (**registry.default_dark_theme()).clone(),
        )
    };
    apply_brand_tokens(&mut light, false);
    apply_brand_tokens(&mut dark, true);
    let theme = Theme::global_mut(cx);
    theme.light_theme = Rc::new(light);
    theme.dark_theme = Rc::new(dark);
}

pub(crate) fn theme_mode_for_appearance(appearance: WindowAppearance) -> ThemeMode {
    match appearance {
        WindowAppearance::Light | WindowAppearance::VibrantLight => ThemeMode::Light,
        _ => ThemeMode::Dark,
    }
}
