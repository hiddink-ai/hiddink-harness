use std::io;

use ratatui::{
    backend::TestBackend,
    layout::{Constraint, Direction, Layout},
    style::{Color, Modifier, Style},
    text::{Line, Span, Text},
    widgets::{Block, Borders, Paragraph, Tabs, Wrap},
    Frame, Terminal,
};

use crate::app::{App, Tab, BACKEND_DISCONNECTED};

pub fn render_app(frame: &mut Frame<'_>, app: &App) {
    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(3),
            Constraint::Length(3),
            Constraint::Min(7),
            Constraint::Length(3),
            Constraint::Length(2),
        ])
        .split(frame.area());

    render_header(frame, chunks[0], app);
    render_tabs(frame, chunks[1], app);
    render_main(frame, chunks[2], app);
    render_input(frame, chunks[3], app);
    render_footer(frame, chunks[4], app);
}

fn render_header(frame: &mut Frame<'_>, area: ratatui::layout::Rect, app: &App) {
    let header = Paragraph::new(Text::from(vec![
        Line::from(vec![
            Span::styled(
                "hiddink-harness",
                Style::default()
                    .fg(Color::Cyan)
                    .add_modifier(Modifier::BOLD),
            ),
            Span::raw(" · Rust ratatui TUI"),
        ]),
        Line::from(vec![
            Span::styled(
                "Phase 1",
                Style::default()
                    .fg(Color::Yellow)
                    .add_modifier(Modifier::BOLD),
            ),
            Span::raw(" standalone scaffold · "),
            Span::styled(app.backend_status(), Style::default().fg(Color::Red)),
        ]),
    ]))
    .block(Block::default().borders(Borders::ALL).title("Header"));

    frame.render_widget(header, area);
}

fn render_tabs(frame: &mut Frame<'_>, area: ratatui::layout::Rect, app: &App) {
    let titles = Tab::ALL
        .iter()
        .map(|tab| Line::from(Span::raw(format!(" {} ", tab.label()))))
        .collect::<Vec<_>>();

    let tabs = Tabs::new(titles)
        .block(Block::default().borders(Borders::ALL).title("Tabs"))
        .select(app.active_tab().index())
        .style(Style::default().fg(Color::Gray))
        .highlight_style(
            Style::default()
                .fg(Color::Black)
                .bg(Color::Green)
                .add_modifier(Modifier::BOLD),
        );

    frame.render_widget(tabs, area);
}

fn render_main(frame: &mut Frame<'_>, area: ratatui::layout::Rect, app: &App) {
    let title = match app.active_tab() {
        Tab::Talk => "Talk",
        Tab::Sessions => "Sessions placeholder",
        Tab::Rag => "RAG placeholder",
        Tab::Settings => "Settings placeholder",
    };

    let lines = match app.active_tab() {
        Tab::Talk => talk_lines(app),
        Tab::Sessions => vec![
            Line::from("No backend/session listing yet (phase 1 placeholder)."),
            Line::from("Future IPC: listSessions."),
            Line::from(Span::styled(
                BACKEND_DISCONNECTED,
                Style::default().fg(Color::Red),
            )),
        ],
        Tab::Rag => vec![
            Line::from("No memory index connected yet (phase 1 placeholder)."),
            Line::from(
                "Memory DB path will be provided by the TypeScript backend in a later phase.",
            ),
            Line::from(Span::styled(
                BACKEND_DISCONNECTED,
                Style::default().fg(Color::Red),
            )),
        ],
        Tab::Settings => vec![
            Line::from("Static/current-process values only (phase 1 placeholder)."),
            Line::from(format!("cwd: {}", app.cwd())),
            Line::from("active providers: not connected"),
            Line::from(Span::styled(
                BACKEND_DISCONNECTED,
                Style::default().fg(Color::Red),
            )),
        ],
    };

    let main = Paragraph::new(Text::from(lines))
        .block(Block::default().borders(Borders::ALL).title(title))
        .wrap(Wrap { trim: true });

    frame.render_widget(main, area);
}

fn talk_lines(app: &App) -> Vec<Line<'static>> {
    let mut lines = vec![
        Line::from("Type a message or slash command. Messages are not sent in Phase 1."),
        Line::from(Span::styled(
            BACKEND_DISCONNECTED,
            Style::default().fg(Color::Red),
        )),
        Line::from(""),
    ];

    if app.messages().is_empty() {
        lines.push(Line::from(Span::styled(
            "No messages yet. Start typing to exercise the input UI.",
            Style::default().fg(Color::DarkGray),
        )));
    } else {
        for message in app.messages().iter().rev().take(8).rev() {
            lines.push(Line::from(vec![
                Span::styled(
                    format!("{}: ", message.role),
                    Style::default()
                        .fg(Color::Green)
                        .add_modifier(Modifier::BOLD),
                ),
                Span::raw(message.content.clone()),
            ]));
        }
    }

    lines
}

fn render_input(frame: &mut Frame<'_>, area: ratatui::layout::Rect, app: &App) {
    let input = if app.input().is_empty() {
        "> ".to_string()
    } else {
        format!("> {}", app.input())
    };

    let paragraph = Paragraph::new(input)
        .block(Block::default().borders(Borders::ALL).title("Input"))
        .style(Style::default().fg(Color::White));

    frame.render_widget(paragraph, area);
}

fn render_footer(frame: &mut Frame<'_>, area: ratatui::layout::Rect, app: &App) {
    let footer = Paragraph::new(Text::from(vec![
        Line::from(
            "Tab/←/→ tabs · /sessions /rag /settings /talk /exit · Esc clear/back · Ctrl-C/q exit",
        ),
        Line::from(vec![
            Span::styled("status: ", Style::default().fg(Color::Yellow)),
            Span::raw(app.status_line().to_string()),
        ]),
    ]));

    frame.render_widget(footer, area);
}

pub fn render_to_string(app: &App, width: u16, height: u16) -> io::Result<String> {
    let backend = TestBackend::new(width, height);
    let mut terminal = match Terminal::new(backend) {
        Ok(terminal) => terminal,
        Err(error) => match error {},
    };
    match terminal.draw(|frame| render_app(frame, app)) {
        Ok(_) => {}
        Err(error) => match error {},
    }

    let buffer = terminal.backend().buffer();
    let mut rendered = String::new();
    for y in 0..buffer.area.height {
        for x in 0..buffer.area.width {
            if let Some(cell) = buffer.cell((x, y)) {
                rendered.push_str(cell.symbol());
            }
        }
        rendered.push('\n');
    }

    Ok(rendered)
}

pub fn smoke_render(app: &App) -> io::Result<()> {
    let rendered = render_to_string(app, 100, 28)?;
    for expected in [
        "hiddink-harness",
        "talk",
        "sessions",
        "rag",
        "settings",
        BACKEND_DISCONNECTED,
    ] {
        if !rendered.contains(expected) {
            return Err(io::Error::new(
                io::ErrorKind::Other,
                format!("smoke render missing expected text: {expected}"),
            ));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{render_to_string, smoke_render};
    use crate::{
        app::{App, Tab, BACKEND_DISCONNECTED},
        event::AppEvent,
    };

    #[test]
    fn render_contains_disconnected_backend_status() {
        let app = App::new("/tmp/project");
        let rendered = render_to_string(&app, 100, 28).expect("render frame");

        assert!(rendered.contains(BACKEND_DISCONNECTED));
        assert!(rendered.contains("hiddink-harness"));
        assert!(rendered.contains("Input"));
    }

    #[test]
    fn placeholder_tabs_are_explicitly_labeled() {
        let mut app = App::new("/tmp/project");

        app.set_input("/sessions");
        app.handle_event(AppEvent::Submit);
        assert_eq!(app.active_tab(), Tab::Sessions);
        let sessions = render_to_string(&app, 100, 28).expect("render sessions");
        assert!(sessions.contains("No backend/session listing yet"));

        app.set_input("/rag");
        app.handle_event(AppEvent::Submit);
        let rag = render_to_string(&app, 100, 28).expect("render rag");
        assert!(rag.contains("No memory index connected yet"));

        app.set_input("/settings");
        app.handle_event(AppEvent::Submit);
        let settings = render_to_string(&app, 100, 28).expect("render settings");
        assert!(settings.contains("Static/current-process values only"));
    }

    #[test]
    fn smoke_render_checks_required_regions() {
        let app = App::new("/tmp/project");
        smoke_render(&app).expect("smoke render");
    }
}
