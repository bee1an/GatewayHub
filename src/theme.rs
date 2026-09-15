//! Brand theme — copied from Heimdall's `window_setup.rs`
//! `apply_brand_tokens`: Apple-flavored cool neutrals + brass accent
//! (`#c08532`), translucent window background over the Blurred material.

use gpui_kit::component::{Theme, ThemeConfig, ThemeMode, ThemeRegistry};
use gpui_kit::{App, WindowAppearance};
use std::rc::Rc;

pub(crate) fn apply_brand_tokens(cfg: &mut ThemeConfig, dark: bool) {
    cfg.radius = Some(10);
    cfg.radius_lg = Some(14);
    cfg.shadow = Some(true);
    let c = &mut cfg.colors;
    let secondary_text = if dark { "#e2e2e6" } else { "#45454a" };
    if dark {
        c.background = Some("#1f1f21bd".into());
        c.foreground = Some("#f2f2f2".into());
        c.muted = Some("#2c2c2e".into());
        c.muted_foreground = Some(secondary_text.into());
        c.border = Some("#ffffff1a".into());
        c.input = Some("#ffffff0d".into());
        c.ring = Some("#c08532".into());
        c.caret = Some("#f2f2f2".into());
        c.sidebar = Some("#242426".into());
        c.sidebar_foreground = Some("#f2f2f2".into());
        c.sidebar_border = Some("#ffffff1a".into());
        c.sidebar_accent = Some("#2c2c2e".into());
        c.sidebar_primary = Some("#c08532".into());
        c.sidebar_primary_foreground = Some("#1f1f21".into());
        c.group_box = Some("#2a2a2c".into());
        c.group_box_foreground = Some("#f2f2f2".into());
        c.group_box_title_foreground = Some(secondary_text.into());
        c.list = Some("#00000000".into());
        c.list_head = Some("#242426".into());
        c.list_even = Some("#242426".into());
        c.list_hover = Some("#ffffff0a".into());
        c.list_active = Some("#c0853236".into());
        c.list_active_border = Some("#ffffff1f".into());
        c.accent = Some("#ffffff0d".into());
        c.accent_foreground = Some("#f2f2f2".into());
        c.primary = Some("#c08532".into());
        c.primary_foreground = Some("#1f1f21".into());
        c.primary_hover = Some("#d09548".into());
        c.primary_active = Some("#a8722a".into());
        c.secondary = Some("#2c2c2e".into());
        c.secondary_foreground = Some("#f2f2f2".into());
        c.secondary_hover = Some("#323234".into());
        c.secondary_active = Some("#3a3a3c".into());
        c.button = Some("#2c2c2e".into());
        c.button_foreground = Some("#f2f2f2".into());
        c.button_hover = Some("#323234".into());
        c.button_active = Some("#3a3a3c".into());
        c.button_primary = Some("#c08532".into());
        c.button_primary_foreground = Some("#1f1f21".into());
        c.button_primary_hover = Some("#d09548".into());
        c.button_primary_active = Some("#a8722a".into());
        c.button_secondary = Some("#2c2c2e".into());
        c.button_secondary_foreground = Some("#f2f2f2".into());
        c.button_secondary_hover = Some("#323234".into());
        c.button_secondary_active = Some("#3a3a3c".into());
        c.popover = Some("#2c2c2e".into());
        c.popover_foreground = Some("#f2f2f2".into());
        c.title_bar = Some("#00000000".into());
        c.title_bar_border = Some("#ffffff12".into());
        c.tab_bar = Some("#242426".into());
        c.tab = Some("#242426".into());
        c.tab_foreground = Some(secondary_text.into());
        c.tab_active = Some("#2c2c2e".into());
        c.tab_active_foreground = Some("#f2f2f2".into());
        c.tab_bar_segmented = Some("#2a2a2c".into());
        c.table = Some("#00000000".into());
        c.table_head = Some("#242426".into());
        c.table_head_foreground = Some(secondary_text.into());
        c.table_row_border = Some("#ffffff14".into());
        c.table_even = Some("#242426".into());
        c.table_hover = Some("#ffffff0a".into());
        c.table_active = Some("#c0853236".into());
        c.table_active_border = Some("#ffffff1f".into());
        c.table_foot = Some("#242426".into());
        c.table_foot_foreground = Some(secondary_text.into());
        c.scrollbar = Some("#00000000".into());
        c.scrollbar_thumb = Some("#ffffff1f".into());
        c.scrollbar_thumb_hover = Some("#ffffff2e".into());
        c.slider_bar = Some("#3a3a3c".into());
        c.slider_thumb = Some("#f2f2f2".into());
        c.switch = Some("#3a3a3c".into());
        c.switch_thumb = Some("#f2f2f2".into());
        c.selection = Some("#c0853259".into());
        c.link = Some("#d09548".into());
        c.link_hover = Some("#e0a55c".into());
        c.link_active = Some("#c08532".into());
        c.progress_bar = Some("#c08532".into());
        c.skeleton = Some("#ffffff0f".into());
        c.accordion = Some("#242426".into());
        c.description_list_label = Some("#242426".into());
        c.description_list_label_foreground = Some(secondary_text.into());
        c.drag_border = Some("#ffffff1f".into());
        c.drop_target = Some("#c08532".into());
        c.tiles = Some("#242426".into());
        c.info = Some("#a3a3a8".into());
        c.info_foreground = Some("#1f1f21".into());
        c.info_hover = Some("#b8b8be".into());
        c.info_active = Some("#a3a3a8".into());
        c.window_border = Some("#3a3a3c".into());
    } else {
        c.background = Some("#f6f6f7c9".into());
        c.foreground = Some("#1d1d1f".into());
        c.muted = Some("#ececef".into());
        c.muted_foreground = Some(secondary_text.into());
        c.border = Some("#00000014".into());
        c.input = Some("#00000006".into());
        c.ring = Some("#a8722a".into());
        c.caret = Some("#1d1d1f".into());
        c.sidebar = Some("#ececef".into());
        c.sidebar_foreground = Some("#1d1d1f".into());
        c.sidebar_border = Some("#00000014".into());
        c.sidebar_accent = Some("#f6f6f7".into());
        c.sidebar_primary = Some("#a8722a".into());
        c.sidebar_primary_foreground = Some("#ffffff".into());
        c.group_box = Some("#fdfdfd".into());
        c.group_box_foreground = Some("#1d1d1f".into());
        c.group_box_title_foreground = Some(secondary_text.into());
        c.list = Some("#00000000".into());
        c.list_head = Some("#ececef".into());
        c.list_even = Some("#ececef".into());
        c.list_hover = Some("#00000008".into());
        c.list_active = Some("#a8722a30".into());
        c.list_active_border = Some("#00000014".into());
        c.accent = Some("#00000008".into());
        c.accent_foreground = Some("#1d1d1f".into());
        c.primary = Some("#a8722a".into());
        c.primary_foreground = Some("#ffffff".into());
        c.primary_hover = Some("#c08532".into());
        c.primary_active = Some("#8c5f22".into());
        c.secondary = Some("#ececef".into());
        c.secondary_foreground = Some("#1d1d1f".into());
        c.secondary_hover = Some("#e1e1e5".into());
        c.secondary_active = Some("#d6d6db".into());
        c.button = Some("#ececef".into());
        c.button_foreground = Some("#1d1d1f".into());
        c.button_hover = Some("#e1e1e5".into());
        c.button_active = Some("#d6d6db".into());
        c.button_primary = Some("#a8722a".into());
        c.button_primary_foreground = Some("#ffffff".into());
        c.button_primary_hover = Some("#c08532".into());
        c.button_primary_active = Some("#8c5f22".into());
        c.button_secondary = Some("#ececef".into());
        c.button_secondary_foreground = Some("#1d1d1f".into());
        c.button_secondary_hover = Some("#e1e1e5".into());
        c.button_secondary_active = Some("#d6d6db".into());
        c.popover = Some("#ffffff".into());
        c.popover_foreground = Some("#1d1d1f".into());
        c.title_bar = Some("#00000000".into());
        c.title_bar_border = Some("#00000010".into());
        c.tab_bar = Some("#ececef".into());
        c.tab = Some("#ececef".into());
        c.tab_foreground = Some(secondary_text.into());
        c.tab_active = Some("#ffffff".into());
        c.tab_active_foreground = Some("#1d1d1f".into());
        c.tab_bar_segmented = Some("#ececef".into());
        c.table = Some("#00000000".into());
        c.table_head = Some("#ececef".into());
        c.table_head_foreground = Some(secondary_text.into());
        c.table_row_border = Some("#00000014".into());
        c.table_even = Some("#ececef".into());
        c.table_hover = Some("#00000008".into());
        c.table_active = Some("#a8722a30".into());
        c.table_active_border = Some("#00000014".into());
        c.table_foot = Some("#ececef".into());
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
        c.accordion = Some("#ececef".into());
        c.description_list_label = Some("#ececef".into());
        c.description_list_label_foreground = Some(secondary_text.into());
        c.drag_border = Some("#00000014".into());
        c.drop_target = Some("#a8722a".into());
        c.tiles = Some("#ececef".into());
        c.info = Some("#636368".into());
        c.info_foreground = Some("#ffffff".into());
        c.info_hover = Some("#515156".into());
        c.info_active = Some("#636368".into());
        c.window_border = Some("#d1d1d6".into());
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
