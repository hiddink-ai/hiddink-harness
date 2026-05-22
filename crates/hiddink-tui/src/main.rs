use std::{env, error::Error, io, panic, time::Duration};

use crossterm::{
    cursor, execute,
    terminal::{disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen},
};
use hiddink_tui::{
    app::App,
    event::read_app_event,
    ui::{render_app, smoke_render},
};
use ratatui::{backend::CrosstermBackend, Terminal};

fn main() -> Result<(), Box<dyn Error>> {
    if env::args().any(|arg| arg == "--smoke") {
        let app = App::new(current_dir_display());
        smoke_render(&app)?;
        println!("hiddink-tui smoke render ok");
        return Ok(());
    }

    run_interactive()
}

fn run_interactive() -> Result<(), Box<dyn Error>> {
    let _guard = TerminalRestoreGuard::enter()?;
    let stdout = io::stdout();
    let backend = CrosstermBackend::new(stdout);
    let mut terminal = Terminal::new(backend)?;
    let mut app = App::new(current_dir_display());

    loop {
        terminal.draw(|frame| render_app(frame, &app))?;

        if app.should_quit() {
            break;
        }

        if let Some(event) = read_app_event(Duration::from_millis(200))? {
            app.handle_event(event);
        }
    }

    terminal.show_cursor()?;
    Ok(())
}

fn current_dir_display() -> String {
    env::current_dir()
        .map(|path| path.display().to_string())
        .unwrap_or_else(|_| "<unknown cwd>".to_string())
}

struct TerminalRestoreGuard;

impl TerminalRestoreGuard {
    fn enter() -> io::Result<Self> {
        enable_raw_mode()?;
        if let Err(error) = execute!(io::stdout(), EnterAlternateScreen, cursor::Hide) {
            restore_terminal();
            return Err(error);
        }
        install_panic_restore_hook();
        Ok(Self)
    }
}

impl Drop for TerminalRestoreGuard {
    fn drop(&mut self) {
        restore_terminal();
    }
}

fn install_panic_restore_hook() {
    let previous_hook = panic::take_hook();
    panic::set_hook(Box::new(move |info| {
        restore_terminal();
        previous_hook(info);
    }));
}

fn restore_terminal() {
    let _ = disable_raw_mode();
    let _ = execute!(io::stdout(), LeaveAlternateScreen, cursor::Show);
}
