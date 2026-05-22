use std::{io, time::Duration};

use crossterm::event::{
    self as crossterm_event, Event, KeyCode, KeyEvent, KeyEventKind, KeyModifiers,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AppEvent {
    NextTab,
    PreviousTab,
    Submit,
    Esc,
    Backspace,
    CtrlC,
    Char(char),
}

pub fn read_app_event(timeout: Duration) -> io::Result<Option<AppEvent>> {
    if !crossterm_event::poll(timeout)? {
        return Ok(None);
    }

    match crossterm_event::read()? {
        Event::Key(key) => Ok(map_key_event(key)),
        _ => Ok(None),
    }
}

pub fn map_key_event(key: KeyEvent) -> Option<AppEvent> {
    if key.kind != KeyEventKind::Press {
        return None;
    }

    match key.code {
        KeyCode::Tab | KeyCode::Right => Some(AppEvent::NextTab),
        KeyCode::Left => Some(AppEvent::PreviousTab),
        KeyCode::Enter => Some(AppEvent::Submit),
        KeyCode::Esc => Some(AppEvent::Esc),
        KeyCode::Backspace => Some(AppEvent::Backspace),
        KeyCode::Char('c') if key.modifiers.contains(KeyModifiers::CONTROL) => {
            Some(AppEvent::CtrlC)
        }
        KeyCode::Char(ch)
            if !key.modifiers.contains(KeyModifiers::CONTROL)
                && !key.modifiers.contains(KeyModifiers::ALT) =>
        {
            Some(AppEvent::Char(ch))
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::{map_key_event, AppEvent};
    use crossterm::event::{KeyCode, KeyEvent, KeyEventKind, KeyModifiers};

    fn key(code: KeyCode, modifiers: KeyModifiers) -> KeyEvent {
        let mut event = KeyEvent::new(code, modifiers);
        event.kind = KeyEventKind::Press;
        event
    }

    #[test]
    fn maps_navigation_and_submit_keys() {
        assert_eq!(
            map_key_event(key(KeyCode::Tab, KeyModifiers::NONE)),
            Some(AppEvent::NextTab)
        );
        assert_eq!(
            map_key_event(key(KeyCode::Right, KeyModifiers::NONE)),
            Some(AppEvent::NextTab)
        );
        assert_eq!(
            map_key_event(key(KeyCode::Left, KeyModifiers::NONE)),
            Some(AppEvent::PreviousTab)
        );
        assert_eq!(
            map_key_event(key(KeyCode::Enter, KeyModifiers::NONE)),
            Some(AppEvent::Submit)
        );
        assert_eq!(
            map_key_event(key(KeyCode::Esc, KeyModifiers::NONE)),
            Some(AppEvent::Esc)
        );
    }

    #[test]
    fn maps_ctrl_c_and_plain_chars() {
        assert_eq!(
            map_key_event(key(KeyCode::Char('c'), KeyModifiers::CONTROL)),
            Some(AppEvent::CtrlC)
        );
        assert_eq!(
            map_key_event(key(KeyCode::Char('/'), KeyModifiers::NONE)),
            Some(AppEvent::Char('/'))
        );
        assert_eq!(
            map_key_event(key(KeyCode::Char('x'), KeyModifiers::ALT)),
            None
        );
    }
}
