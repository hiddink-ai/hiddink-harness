use crate::event::AppEvent;

pub const BACKEND_DISCONNECTED: &str = "backend: disconnected (phase 1 scaffold)";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Tab {
    Talk,
    Sessions,
    Rag,
    Settings,
}

impl Tab {
    pub const ALL: [Tab; 4] = [Tab::Talk, Tab::Sessions, Tab::Rag, Tab::Settings];

    pub const fn label(self) -> &'static str {
        match self {
            Tab::Talk => "talk",
            Tab::Sessions => "sessions",
            Tab::Rag => "rag",
            Tab::Settings => "settings",
        }
    }

    pub const fn index(self) -> usize {
        match self {
            Tab::Talk => 0,
            Tab::Sessions => 1,
            Tab::Rag => 2,
            Tab::Settings => 3,
        }
    }

    pub fn next(self) -> Self {
        Self::ALL[(self.index() + 1) % Self::ALL.len()]
    }

    pub fn previous(self) -> Self {
        Self::ALL[(self.index() + Self::ALL.len() - 1) % Self::ALL.len()]
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DisplayMessage {
    pub role: &'static str,
    pub content: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct App {
    active_tab: Tab,
    input: String,
    should_quit: bool,
    status_line: String,
    cwd: String,
    messages: Vec<DisplayMessage>,
}

impl App {
    pub fn new(cwd: impl Into<String>) -> Self {
        Self {
            active_tab: Tab::Talk,
            input: String::new(),
            should_quit: false,
            status_line: "Phase 1 scaffold ready; backend is not connected.".to_string(),
            cwd: cwd.into(),
            messages: Vec::new(),
        }
    }

    pub const fn active_tab(&self) -> Tab {
        self.active_tab
    }

    pub fn input(&self) -> &str {
        &self.input
    }

    pub fn set_input(&mut self, input: impl Into<String>) {
        self.input = input.into();
    }

    pub const fn should_quit(&self) -> bool {
        self.should_quit
    }

    pub fn status_line(&self) -> &str {
        &self.status_line
    }

    pub const fn backend_status(&self) -> &'static str {
        BACKEND_DISCONNECTED
    }

    pub fn cwd(&self) -> &str {
        &self.cwd
    }

    pub fn messages(&self) -> &[DisplayMessage] {
        &self.messages
    }

    pub fn handle_event(&mut self, event: AppEvent) {
        match event {
            AppEvent::NextTab => self.switch_tab(self.active_tab.next()),
            AppEvent::PreviousTab => self.switch_tab(self.active_tab.previous()),
            AppEvent::Submit => self.submit_input(),
            AppEvent::Esc => self.handle_escape(),
            AppEvent::Backspace => {
                self.input.pop();
            }
            AppEvent::CtrlC => self.request_quit("Ctrl-C"),
            AppEvent::Char('q') if self.input.is_empty() => self.request_quit("q"),
            AppEvent::Char(ch) => self.input.push(ch),
        }
    }

    fn switch_tab(&mut self, tab: Tab) {
        self.active_tab = tab;
        self.status_line = format!(
            "{} tab selected (phase 1 placeholder where applicable).",
            tab.label()
        );
    }

    fn submit_input(&mut self) {
        let trimmed = self.input.trim().to_string();
        if trimmed.is_empty() {
            return;
        }

        if let Some(command) = trimmed.strip_prefix('/') {
            self.handle_slash_command(command);
        } else {
            self.messages.push(DisplayMessage {
                role: "user",
                content: trimmed,
            });
            self.status_line =
                "Backend is disconnected; message captured locally and not sent.".to_string();
        }
        self.input.clear();
    }

    fn handle_slash_command(&mut self, command: &str) {
        match command {
            "talk" => self.switch_tab(Tab::Talk),
            "sessions" => self.switch_tab(Tab::Sessions),
            "rag" => self.switch_tab(Tab::Rag),
            "settings" => self.switch_tab(Tab::Settings),
            "exit" => self.request_quit("/exit"),
            other => {
                self.status_line =
                    format!("Unknown command: /{other}. Try /sessions /rag /settings /talk /exit.");
            }
        }
    }

    fn handle_escape(&mut self) {
        if !self.input.is_empty() {
            self.input.clear();
            self.status_line = "Input cleared.".to_string();
        } else if self.active_tab != Tab::Talk {
            self.switch_tab(Tab::Talk);
        } else {
            self.status_line = "Already on talk tab.".to_string();
        }
    }

    fn request_quit(&mut self, trigger: &str) {
        self.should_quit = true;
        self.status_line = format!("Exit requested by {trigger}.");
    }
}

#[cfg(test)]
mod tests {
    use super::{App, Tab};
    use crate::event::AppEvent;

    #[test]
    fn tab_cycling_wraps_in_both_directions() {
        let mut app = App::new("/tmp/project");
        assert_eq!(app.active_tab(), Tab::Talk);

        app.handle_event(AppEvent::PreviousTab);
        assert_eq!(app.active_tab(), Tab::Settings);

        app.handle_event(AppEvent::NextTab);
        assert_eq!(app.active_tab(), Tab::Talk);

        app.handle_event(AppEvent::NextTab);
        assert_eq!(app.active_tab(), Tab::Sessions);
        app.handle_event(AppEvent::NextTab);
        assert_eq!(app.active_tab(), Tab::Rag);
        app.handle_event(AppEvent::NextTab);
        assert_eq!(app.active_tab(), Tab::Settings);
        app.handle_event(AppEvent::NextTab);
        assert_eq!(app.active_tab(), Tab::Talk);
    }

    #[test]
    fn slash_commands_switch_to_placeholder_tabs() {
        let mut app = App::new("/tmp/project");

        for (command, expected) in [
            ("/sessions", Tab::Sessions),
            ("/rag", Tab::Rag),
            ("/settings", Tab::Settings),
            ("/talk", Tab::Talk),
        ] {
            app.set_input(command);
            app.handle_event(AppEvent::Submit);
            assert_eq!(app.active_tab(), expected);
            assert!(app.input().is_empty());
        }
    }

    #[test]
    fn exit_commands_request_shutdown() {
        let mut slash_exit = App::new("/tmp/project");
        slash_exit.set_input("/exit");
        slash_exit.handle_event(AppEvent::Submit);
        assert!(slash_exit.should_quit());

        let mut ctrl_c = App::new("/tmp/project");
        ctrl_c.handle_event(AppEvent::CtrlC);
        assert!(ctrl_c.should_quit());

        let mut q_shortcut = App::new("/tmp/project");
        q_shortcut.handle_event(AppEvent::Char('q'));
        assert!(q_shortcut.should_quit());
    }

    #[test]
    fn q_is_text_when_message_input_is_non_empty() {
        let mut app = App::new("/tmp/project");
        app.set_input("hello ");
        app.handle_event(AppEvent::Char('q'));

        assert!(!app.should_quit());
        assert_eq!(app.input(), "hello q");
    }

    #[test]
    fn esc_clears_input_before_switching_tabs() {
        let mut app = App::new("/tmp/project");
        app.set_input("draft");
        app.handle_event(AppEvent::Esc);

        assert_eq!(app.active_tab(), Tab::Talk);
        assert!(app.input().is_empty());
        assert_eq!(app.status_line(), "Input cleared.");

        app.set_input("/sessions");
        app.handle_event(AppEvent::Submit);
        assert_eq!(app.active_tab(), Tab::Sessions);

        app.handle_event(AppEvent::Esc);
        assert_eq!(app.active_tab(), Tab::Talk);
    }

    #[test]
    fn plain_messages_are_not_sent_to_a_fake_backend() {
        let mut app = App::new("/tmp/project");
        app.set_input("hello backend");
        app.handle_event(AppEvent::Submit);

        assert_eq!(app.messages().len(), 1);
        assert_eq!(app.messages()[0].content, "hello backend");
        assert!(app.status_line().contains("Backend is disconnected"));
    }
}
