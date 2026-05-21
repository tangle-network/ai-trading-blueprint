use std::env;
use std::fs;
use std::path::PathBuf;

use trading_runtime::evals::agent_personas::run_persona_eval_suite;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut out: Option<PathBuf> = None;
    let mut args = env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--out" => {
                let path = args.next().ok_or("--out requires a path")?;
                out = Some(PathBuf::from(path));
            }
            "--help" | "-h" => {
                eprintln!(
                    "usage: cargo run -p trading-runtime --example agent_persona_eval -- [--out <path>]"
                );
                return Ok(());
            }
            other => return Err(format!("unknown argument: {other}").into()),
        }
    }

    let report = run_persona_eval_suite()?;
    let json = serde_json::to_string_pretty(&report)?;
    if let Some(path) = out {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::write(&path, format!("{json}\n"))?;
        println!("{}", path.display());
    } else {
        println!("{json}");
    }

    if report.failed > 0 {
        std::process::exit(1);
    }
    Ok(())
}
