#!/bin/sh
# Runs one agent turn on the remote host and lets the phone follow it.
#
# There is no long-running server. A turn is one `codex exec`, one `claude -p`,
# one `opencode run` or one `pi -a --mode json` hosted in a tmux session that
# exits when the turn is done, and everything the app shows comes from files on
# this host that grow as the turn progresses.
#
#   start KEY         launch the turn, detached from this SSH channel
#   run   KEY         the turn itself; what `start` launches
#   poll  KEY FROM    status plus the live feed from line FROM onward
#   stop  KEY         kill the turn
#
# The turn's inputs are written to files by the app before `start`, so no user
# text ever has to survive a round of shell quoting:
#
#   $dir/prompt   what to send        $dir/model   model, or empty for default
#   $dir/cwd      working directory   $dir/effort  reasoning effort, or empty
#   $dir/thread   session to resume, or empty for a new session
#   $dir/harness  `codex`, `claude`, `opencode` or `pi`; `$dir/bin` that binary
#   $dir/session  claude and pi: the id a new session is created with
#   $dir/permission  claude: --permission-mode; opencode: non-empty adds --auto
#
# codex, claude and pi append to one JSONL file per session, so their live feed
# *is* the session file, tailed from a line cursor. opencode keeps its sessions
# in SQLite, so its live feed is the `--format json` event stream captured in
# $dir/events.jsonl; history is read separately from the database.
#
# All four CLIs read stdin to EOF, and a tmux pane's stdin is a pty that never
# reaches EOF, a turn started with stdin left alone hangs forever, silently.
# The prompt is therefore always fed in with `<"$dir/prompt"`. codex takes the
# prompt as `-`; the others must not (claude treats `-` as a literal prompt
# word and appends stdin to it).
#
set -u

usage() {
	echo "usage: $0 start|run|poll|stop KEY [FROM]" >&2
	exit 2
}

[ $# -ge 2 ] || usage
mode=$1
key=$2

dir="${XDG_CACHE_HOME:-$HOME/.cache}/pabloagent/turns/$key"
session="pabloagent-$key"
self=$0

read_file() {
	[ -f "$1" ] && tr -d '\n' <"$1" || true
}

harness=$(read_file "$dir/harness")
[ -n "$harness" ] || harness=codex

lock_root="${XDG_CACHE_HOME:-$HOME/.cache}/pabloagent/locks"

# True while the turn's supervisor is still going, including the small window
# after `run` writes status but before its tmux session or detached process exits.
supervisor_running() {
	if command -v tmux >/dev/null 2>&1 && tmux has-session -t "$session" 2>/dev/null; then
		return 0
	fi
	pid=$(read_file "$dir/pid")
	[ -n "$pid" ] && kill -0 "$pid" 2>/dev/null
}

# True while the turn's process is still going. The status file is written last
# by `run`, so its absence is what "still going" means; the supervisor is only
# consulted to notice a turn that died without getting that far.
turn_running() {
	[ -f "$dir/status" ] && return 1
	supervisor_running
}

# Resolve a turn to the session it belongs to on the host. This cannot depend
# on the phone polling: several sessions may run while the app is showing
# another chat, disconnected, or not running at all.
sync_identity() {
	found_thread=$(read_file "$dir/resolved_thread")
	if [ -z "$found_thread" ]; then
		found_thread=$(sed -n \
			'1s/.*"thread_id"[[:space:]]*:[[:space:]]*"\([0-9a-fA-F-]*\)".*/\1/p' \
			"$dir/events.jsonl" 2>/dev/null)
		[ -n "$found_thread" ] || found_thread=$(sed -n \
			'1s/.*"session_id"[[:space:]]*:[[:space:]]*"\([0-9a-fA-F-]*\)".*/\1/p' \
			"$dir/events.jsonl" 2>/dev/null)
		[ -n "$found_thread" ] || found_thread=$(sed -n \
			'1s/.*"sessionID"[[:space:]]*:[[:space:]]*"\([A-Za-z0-9_]*\)".*/\1/p' \
			"$dir/events.jsonl" 2>/dev/null)
		[ -n "$found_thread" ] || found_thread=$(sed -n \
			'1s/.*"type"[[:space:]]*:[[:space:]]*"session".*"id"[[:space:]]*:[[:space:]]*"\([0-9a-fA-F-]*\)".*/\1/p' \
			"$dir/events.jsonl" 2>/dev/null)
		[ -n "$found_thread" ] || found_thread=$(read_file "$dir/thread")
		if [ -z "$found_thread" ] && { [ "$harness" = claude ] || [ "$harness" = pi ]; }; then
			found_thread=$(read_file "$dir/session")
		fi
		if [ -n "$found_thread" ]; then
			printf '%s' "$found_thread" >"$dir/resolved_thread.$$.tmp"
			mv -f "$dir/resolved_thread.$$.tmp" "$dir/resolved_thread"
		fi
	fi

	found_rollout=$(read_file "$dir/rollout")
	if [ -z "$found_rollout" ] && [ -n "$found_thread" ]; then
		if [ "$harness" = claude ]; then
			found_rollout=$(find "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/projects" \
				-mindepth 2 -maxdepth 2 -type f -name "$found_thread.jsonl" 2>/dev/null |
				sort | tail -n 1)
		elif [ "$harness" = pi ]; then
			found_rollout=$(find "${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/sessions" \
				-mindepth 2 -maxdepth 2 -type f -name "*_$found_thread.jsonl" 2>/dev/null |
				sort | tail -n 1)
		elif [ "$harness" = opencode ]; then
			found_rollout="${XDG_CACHE_HOME:-$HOME/.cache}/pabloagent/opencode/$found_thread.jsonl"
		else
			found_rollout=$(find "${CODEX_HOME:-$HOME/.codex}/sessions" -type f \
				-name "*$found_thread*.jsonl" 2>/dev/null | sort | tail -n 1)
		fi
		if [ -n "$found_rollout" ]; then
			printf '%s' "$found_rollout" >"$dir/rollout.$$.tmp"
			mv -f "$dir/rollout.$$.tmp" "$dir/rollout"
		fi
	fi
}

watch_identity() {
	tries=0
	while [ "$tries" -lt 240 ]; do
		sync_identity
		[ -n "$found_thread" ] && [ -n "$found_rollout" ] && return
		tries=$((tries + 1))
		sleep 0.25
	done
}

release_lock() {
	held=$(read_file "$dir/lock")
	[ -n "$held" ] || return 0
	[ "$(read_file "$held/owner")" = "$key" ] || return 0
	rm -f "$held/owner" 2>/dev/null || true
	rmdir "$held" 2>/dev/null || true
	rm -f "$dir/lock" 2>/dev/null || true
}

finish_signal() {
	trap - EXIT HUP INT TERM
	[ -f "$dir/status" ] || echo 130 >"$dir/status"
	release_lock
	exit 130
}

claim_session() {
	requested=$(read_file "$dir/thread")
	[ -n "$requested" ] || return 0
	case "$harness-$requested" in
	*[!A-Za-z0-9_-]*)
		echo "pabloagent: unsafe session id $requested" >&2
		return 6
		;;
	esac
	mkdir -p "$lock_root" || return 6
	held="$lock_root/$harness-$requested"
	if ! mkdir "$held" 2>/dev/null; then
		owner=$(read_file "$held/owner")
		owner_dir="${XDG_CACHE_HOME:-$HOME/.cache}/pabloagent/turns/$owner"
		owner_status=$(read_file "$owner_dir/status")
		owner_running=false
		if [ -n "$owner" ] && [ -z "$owner_status" ]; then
			if command -v tmux >/dev/null 2>&1 &&
				tmux has-session -t "pabloagent-$owner" 2>/dev/null; then
				owner_running=true
			else
				owner_pid=$(read_file "$owner_dir/pid")
				[ -n "$owner_pid" ] && kill -0 "$owner_pid" 2>/dev/null &&
					owner_running=true
			fi
			# `start` owns the lock just before it creates tmux/the pid. Treat a
			# fresh owner directory as live across that small window; an
			# abandoned claim becomes recoverable after a minute.
			if [ "$owner_running" = false ] && [ -d "$owner_dir" ] &&
				! find "$owner_dir" -maxdepth 0 -mmin +1 -print 2>/dev/null |
					grep -q .; then
				owner_running=true
			fi
		fi
		if [ "$owner_running" = true ]; then
			echo "pabloagent: session $requested already has a running turn" >&2
			return 7
		fi
		rm -f "$held/owner" 2>/dev/null || true
		rmdir "$held" 2>/dev/null || true
		mkdir "$held" 2>/dev/null || {
			echo "pabloagent: session $requested was claimed by another turn" >&2
			return 7
		}
	fi
	printf '%s' "$key" >"$held/owner"
	printf '%s' "$held" >"$dir/lock"
}

# Said on the turn's own stderr, which is what the app shows when a turn looks
# wrong. Trust is best-effort by design: every failure here leaves codex running
# exactly as it did before this existed, so the note is the whole consequence.
trust_note() {
	echo "pabloagent: workspace trust: $1" >>"$dir/stderr"
}

# trust_codex_workspace PATH, write `projects."<path>".trust_level` into
# `$CODEX_HOME/config.toml` before codex runs, so the turn loads that
# workspace's own `.codex/config.toml`, hooks and exec policies; codex ignores
# the same setting passed as `-c`. Three rules: never make the config worse
# (one entry changes, every other byte is copied through as it was); never
# write a duplicate key (`[projects."<path>"]` twice fails config load
# host-wide, so a projects table in a shape the awk cannot read is left alone);
# and never fail the turn, every failure is a stderr note and an untrusted run.
trust_codex_workspace() {
	trust_path=$1
	codex_home=${CODEX_HOME:-$HOME/.codex}
	config="$codex_home/config.toml"
	trust_lock="$lock_root/codex-config"

	mkdir -p "$codex_home" "$lock_root" 2>/dev/null || {
		trust_note "cannot create $codex_home"
		return 0
	}

	# One rewriter at a time: a lost update would silently drop another turn's
	# entry. A claim older than a minute is abandoned, as in `claim_session`.
	tries=0
	until mkdir "$trust_lock" 2>/dev/null; do
		tries=$((tries + 1))
		if [ "$tries" -ge 100 ]; then
			trust_note "another turn held the config lock for ten seconds"
			return 0
		fi
		if find "$trust_lock" -maxdepth 0 -mmin +1 -print 2>/dev/null | grep -q .; then
			rmdir "$trust_lock" 2>/dev/null || true
		fi
		sleep 0.1
	done

	new="$config.pabloagent.$$"
	if [ -f "$config" ]; then
		# `-p` so the rewrite inherits the file's own mode, a 0600 config must
		# not loosen to whatever the umask says.
		cp -p "$config" "$new" 2>/dev/null || cp "$config" "$new" 2>/dev/null || {
			rmdir "$trust_lock" 2>/dev/null || true
			trust_note "cannot write beside $config"
			return 0
		}
	else
		(umask 077 && : >"$new") 2>/dev/null || {
			rmdir "$trust_lock" 2>/dev/null || true
			trust_note "cannot create $config"
			return 0
		}
	fi

	# The path travels in the environment rather than in `-v`, which would eat
	# the backslashes out of it. Exit status: 0 rewrote, 1 already trusted and
	# the file was not touched, 2 refused to edit this file, anything else broke.
	cat "$config" 2>/dev/null | PABLOAGENT_TRUST_PATH=$trust_path awk '
	function trim(s) { sub(/^[ \t]+/, "", s); sub(/[ \t]+$/, "", s); return s }
	function ind(s) { match(s, /^[ \t]*/); return substr(s, 1, RLENGTH) }

	# The path as a TOML basic string, which is how codex itself writes one.
	function esc(s,   i, c, out) {
		out = ""
		for (i = 1; i <= length(s); i++) {
			c = substr(s, i, 1)
			if (c == "\\" || c == "\"") out = out "\\" c
			else if (c == "\t") out = out "\\t"
			else out = out c
		}
		return out
	}

	# Read a quoted key or value off the front of s: KEY is its text with basic
	# escapes resolved, REST is whatever followed the closing quote.
	function quoted(s,   q, i, c, n, out) {
		q = substr(s, 1, 1)
		if (q != "\"" && q != SQ) return 0
		n = length(s)
		out = ""
		for (i = 2; i <= n; i++) {
			c = substr(s, i, 1)
			if (q == "\"" && c == "\\") {
				i++
				c = substr(s, i, 1)
				if (c == "n") c = "\n"
				else if (c == "t") c = "\t"
				else if (c == "r") c = "\r"
				else if (c == "u" || c == "U") return 0
				out = out c
				continue
			}
			if (c == q) { KEY = out; REST = substr(s, i + 1); return 1 }
			out = out c
		}
		return 0
	}

	# The same, for a bare key. A path is never one of these, it has slashes,
	# so a bare key where the workspace would be is simply somebody else.
	function bare(s) {
		if (s !~ /^[A-Za-z0-9_-]+/) return 0
		match(s, /^[A-Za-z0-9_-]+/)
		KEY = substr(s, 1, RLENGTH)
		REST = substr(s, RLENGTH + 1)
		return 1
	}

	function is_trusted(v) { return quoted(v) && KEY == "trusted" }

	# The target table is held rather than printed, so that a table which turns
	# out to have no trust_level in it gets one directly under its header
	# instead of trailing after its last line or its blank line.
	function emit(s) { if (section == "target") buf[++nbuf] = s; else print s }
	function flush_target(   i) {
		if (!done) {
			print "trust_level = \"trusted\""
			done = 1
			changed = 1
		}
		for (i = 1; i <= nbuf; i++) print buf[i]
		nbuf = 0
	}

	# Odd number of q in s, i.e. this line opens or closes a multi-line string.
	function odd(s, q,   at, cnt) {
		cnt = 0
		while ((at = index(s, q)) > 0) { cnt++; s = substr(s, at + length(q)) }
		return cnt % 2
	}

	# Which table a header opens, as far as this cares: the target project on
	# its own, the `projects` table, or somebody else entirely.
	function header(t,   rest, r) {
		rest = substr(t, 2)
		if (substr(rest, 1, 1) == "[") {
			if (trim(substr(rest, 2)) ~ /^projects([ \t]*[.\]]|$)/) unknown = 1
			return "other"
		}
		rest = trim(rest)
		if (rest ~ /^projects[ \t]*\]/) return "projects"
		if (rest !~ /^projects[ \t]*\./) {
			# A quoted spelling of the same table name is legal TOML and not one
			# this reads, so it refuses rather than risk the duplicate.
			if (rest ~ /^"projects"/ || rest ~ ("^" SQ "projects" SQ)) unknown = 1
			return "other"
		}
		sub(/^projects[ \t]*\.[ \t]*/, "", rest)
		if (!quoted(rest)) {
			if (!bare(rest)) unknown = 1
			return "other"
		}
		if (KEY != path) return "other"
		r = trim(REST)
		if (substr(r, 1, 1) == ".") return "other"
		if (substr(r, 1, 1) != "]") { unknown = 1; return "other" }
		return "target"
	}

	BEGIN {
		SQ = "\047"
		path = ENVIRON["PABLOAGENT_TRUST_PATH"]
		section = ""
		block = ""
		done = 0
		changed = 0
		unknown = 0
		nbuf = 0
	}

	{
		line = $0

		# A multi-line string can hold anything, including something shaped
		# exactly like a table header. Its insides are copied, never read.
		if (block != "") {
			emit(line)
			if (index(line, block) > 0) block = ""
			next
		}

		t = trim(line)

		if (substr(t, 1, 1) == "[") {
			# A header ends the table before it, and the target table is only
			# written out once its whole contents have been seen.
			if (section == "target") flush_target()
			section = header(t)
			if (unknown) exit 2
			print line
			next
		}

		if (t == "" || substr(t, 1, 1) == "#") { emit(line); next }

		if (section == "target") {
			if (bare(t) && KEY == "trust_level") {
				r = trim(REST)
				if (substr(r, 1, 1) == "=") {
					if (is_trusted(trim(substr(r, 2)))) {
						emit(line)
						done = 1
						next
					}
					emit(ind(line) "trust_level = \"trusted\"")
					done = 1
					changed = 1
					next
				}
			}
		} else if (section == "projects" && quoted(t) && KEY == path) {
			r = trim(REST)
			# `"<path>" = { ... }`, an inline table this cannot merge into
			# without risking the key twice.
			if (substr(r, 1, 1) == "=") { unknown = 1; exit 2 }
			if (substr(r, 1, 1) == ".") {
				r = trim(substr(r, 2))
				if (bare(r) && KEY == "trust_level" && trim(REST) ~ /^=/) {
					if (is_trusted(trim(substr(trim(REST), 2)))) {
						print line
						done = 1
						next
					}
					print ind(line) "\"" esc(path) "\".trust_level = \"trusted\""
					done = 1
					changed = 1
					next
				}
			}
		} else if (section == "" && bare(t) && KEY == "projects") {
			r = trim(REST)
			# `projects = { ... }`, the whole table inline. Same refusal.
			if (substr(r, 1, 1) == "=") { unknown = 1; exit 2 }
			if (substr(r, 1, 1) == "." && quoted(trim(substr(r, 2))) && KEY == path) {
				r = trim(REST)
				if (substr(r, 1, 1) == "=") { unknown = 1; exit 2 }
				if (substr(r, 1, 1) == ".") {
					r = trim(substr(r, 2))
					if (bare(r) && KEY == "trust_level" && trim(REST) ~ /^=/) {
						if (is_trusted(trim(substr(trim(REST), 2)))) {
							print line
							done = 1
							next
						}
						print ind(line) "projects.\"" esc(path) "\".trust_level = \"trusted\""
						done = 1
						changed = 1
						next
					}
				}
			}
		}

		emit(line)
		if (odd(line, "\"\"\"")) block = "\"\"\""
		else if (odd(line, SQ SQ SQ)) block = SQ SQ SQ
	}

	END {
		if (unknown) exit 2
		if (section == "target") flush_target()
		if (!done) {
			if (NR > 0) print ""
			print "[projects.\"" esc(path) "\"]"
			print "trust_level = \"trusted\""
			changed = 1
		}
		exit changed ? 0 : 1
	}
	' >"$new"
	rc=$?

	case $rc in
	0)
		# A rename would replace a symlinked config with a copy of itself, so
		# that case is written through the link instead, at the cost of the
		# atomicity every other config gets.
		if [ -h "$config" ]; then
			written=$(cat "$new" >"$config" 2>/dev/null && echo yes)
		else
			written=$(mv -f "$new" "$config" 2>/dev/null && echo yes)
		fi
		if [ "$written" != yes ]; then
			trust_note "cannot replace $config"
		fi
		;;
	1) ;; # already trusted, and the file was left untouched on purpose
	2)
		trust_note "left $config alone: its projects table is in a shape this cannot safely edit"
		;;
	*)
		trust_note "could not rewrite $config (exit $rc)"
		;;
	esac

	rm -f "$new" 2>/dev/null || true
	rmdir "$trust_lock" 2>/dev/null || true
}

case $mode in
start)
	[ -f "$dir/prompt" ] || {
		echo "pabloagent: $dir/prompt was not written" >&2
		exit 4
	}
	claim_session || exit $?
	# `bash -lc` gets the login PATH, which is where nvm/asdf/homebrew agent
	# installs live. Passing the script and key as arguments rather than
	# interpolating them into the command string means nothing needs quoting,
	# and tmux takes a real argv, so it survives that hop too.
	if command -v tmux >/dev/null 2>&1; then
		tmux new-session -d -s "$session" bash -lc 'sh "$0" run "$1"' "$self" "$key" || {
			release_lock
			exit 5
		}
		echo "PT_STARTED	tmux"
	else
		# tmux is only a supervisor here: the turn's stdin is a file and its
		# output goes to files, so it needs no terminal to survive a dropped
		# link, just its own session.
		setsid bash -lc 'sh "$0" run "$1"' "$self" "$key" </dev/null >/dev/null 2>&1 &
		echo "$!" >"$dir/pid"
		echo "PT_STARTED	setsid"
	fi
	;;
run)
	trap 'release_lock' EXIT
	trap 'finish_signal' HUP INT TERM
	cwd=$(read_file "$dir/cwd")
	model=$(read_file "$dir/model")
	effort=$(read_file "$dir/effort")
	thread=$(read_file "$dir/thread")
	bin=$(read_file "$dir/bin")
	permission=$(read_file "$dir/permission")
	sid=$(read_file "$dir/session")
	[ -n "$bin" ] || bin=$harness

	if [ -n "$cwd" ]; then
		cd "$cwd" || {
			echo "pabloagent: cannot cd to $cwd" >>"$dir/stderr"
			echo 66 >"$dir/status"
			exit 66
		}
		# `pwd -P` rather than `$cwd`: codex keys the trust decision under its
		# own kernel-resolved cwd, symlinks already gone. A chat with no
		# workspace of its own gets no entry.
		[ "$harness" = codex ] && trust_codex_workspace "$(pwd -P)"
	fi

	if [ "$harness" = claude ]; then
		# `--verbose` is what `--output-format stream-json` requires in print
		# mode. The stream itself is only read for the session id: everything
		# shown in the app comes from the transcript file claude writes.
		set -- "$bin" -p --output-format stream-json --verbose
		if [ -n "$thread" ]; then
			set -- "$@" --resume "$thread"
		elif [ -n "$sid" ]; then
			set -- "$@" --session-id "$sid"
		fi
		[ -n "$model" ] && set -- "$@" --model "$model"
		[ -n "$effort" ] && set -- "$@" --effort "$effort"
		[ -n "$permission" ] && set -- "$@" --permission-mode "$permission"
	elif [ "$harness" = pi ]; then
		# The `--mode json` stream is only read for the session id on its first
		# line: everything shown comes from the session file pi writes.
		#
		# The login shell's node (nvm et al) can be too old for pi, so when
		# /usr/bin/node exists and pi is a node script (a shebang naming node,
		# not an ELF binary), run it through the system node. The probe applies
		# the same rule, or such a host would hide pi from the new-chat dialog.
		#
		# `-a` autotrusts the workspace; without it a non-interactive turn
		# silently loses the project's own .pi configuration.
		pibin=$(command -v "$bin" 2>/dev/null || echo "$bin")
		if [ -x /usr/bin/node ] && head -c 64 "$pibin" 2>/dev/null | grep -q '^#!.*node'; then
			set -- /usr/bin/node "$pibin" -a --mode json
		else
			set -- "$bin" -a --mode json
		fi
		if [ -n "$thread" ]; then
			set -- "$@" --session-id "$thread"
		elif [ -n "$sid" ]; then
			set -- "$@" --session-id "$sid"
		fi
		[ -n "$model" ] && set -- "$@" --model "$model"
		[ -n "$effort" ] && set -- "$@" --thinking "$effort"
	elif [ "$harness" = opencode ]; then
		# The `--format json` stream on stdout is this harness's live feed, not
		# just where the session id is read from, opencode keeps its sessions
		# in SQLite, so there is no session file to tail. `--thinking` puts the
		# reasoning parts in the stream; without it they exist only in the
		# database and a live turn would show tools with no thought between.
		set -- "$bin" run --format json --thinking
		if [ -n "$thread" ]; then
			set -- "$@" -s "$thread"
		else
			# Bare `--title` = "title the session after the prompt". Only for a
			# new session, on a resume it would rename the one being joined.
			set -- "$@" --title
		fi
		[ -n "$model" ] && set -- "$@" -m "$model"
		# An unsupported variant is ignored rather than refused, so passing one
		# through is safe on any model.
		[ -n "$effort" ] && set -- "$@" --variant "$effort"
		[ -n "$permission" ] && set -- "$@" --auto
	else
		set -- "$bin" exec
		[ -n "$thread" ] && set -- "$@" resume "$thread"
		set -- "$@" --json --skip-git-repo-check
		[ -n "$model" ] && set -- "$@" -m "$model"
		[ -n "$effort" ] && set -- "$@" -c "model_reasoning_effort=\"$effort\""
		# The tier is pinned rather than left to the config: the rollout records
		# no service_tier, so a fast turn could not survive a resume, and some
		# models default to the fast tier. "default" is the one id every model
		# accepts silently.
		set -- "$@" -c "service_tier=\"default\""
		set -- "$@" -
	fi

	watch_identity &
	identity_watcher=$!
	# Record the process that becomes the CLI itself. The tiny foreground shell
	# writes its pid and then execs, so stop can deliver SIGINT to the agent
	# without also interrupting this supervisor before it records the outcome.
	sh -c 'printf "%s" "$$" >"${1}.tmp" && mv -f "${1}.tmp" "$1" || exit 70; shift; exec "$@"' \
		pabloagent "$dir/agent_pid" "$@" \
		<"$dir/prompt" >>"$dir/events.jsonl" 2>>"$dir/stderr"
	status=$?
	sync_identity
	kill "$identity_watcher" 2>/dev/null || true
	wait "$identity_watcher" 2>/dev/null || true
	echo "$status" >"$dir/status"
	release_lock
	trap - EXIT HUP INT TERM
	exit "$status"
	;;
poll)
	[ $# -ge 3 ] || usage
	from=$3
	[ -d "$dir" ] || {
		echo "pabloagent: no such turn $key" >&2
		exit 4
	}

	exited=$(read_file "$dir/status")
	if [ -n "$exited" ]; then
		running=false
	elif supervisor_running; then
		# Status is written before the supervisor exits. If it appears after the
		# read above, reporting this snapshot as still running is consistent and
		# the next poll will observe the completed status.
		running=true
		exited=-
	else
		# Close the opposite race: the supervisor may have written status while
		# it was disappearing, so read once more before calling it statusless.
		running=false
		exited=$(read_file "$dir/status")
		[ -n "$exited" ] || exited=-
	fi

	sync_identity
	thread=$found_thread
	rollout=$found_rollout

	# What the phone tails. For the file-based harnesses that is the session
	# file itself; for opencode it is this turn's own event stream, the one
	# append-only record of the turn, since the session store is a database
	# whose rows mutate while the turn streams.
	feed=$rollout
	[ "$harness" = opencode ] && feed="$dir/events.jsonl"

	# Tab-separated so nothing needs escaping, and the path gets its own line
	# rather than going inside JSON where a quote in it would matter.
	printf 'PT_STATUS\trunning=%s\texit=%s\tfrom=%s\n' "$running" "$exited" "$from"
	printf 'PT_THREAD\t%s\n' "$thread"
	printf 'PT_ROLLOUT\t%s\n' "$rollout"
	# base64 so stderr's own newlines cannot be mistaken for the framing.
	printf 'PT_STDERR\t%s\n' "$(tail -c 2000 "$dir/stderr" 2>/dev/null | base64 | tr -d '\n')"
	echo PT_LINES
	# One page, not the whole tail: 4194304 is remote.rs's
	# SESSION_READ_BYTE_CAP, and the line cursor makes the next poll carry on
	# from this page's last complete line. Without the cap a huge rollout is
	# collected whole into a phone's memory.
	[ -n "$feed" ] && tail -n +"$from" "$feed" 2>/dev/null | head -c 4194304
	exit 0
	;;
stop)
	# A stop can race the tmux launch. Give `run` a short chance to record the
	# process that becomes the CLI before deciding there is nothing to signal.
	agent_pid=$(read_file "$dir/agent_pid")
	tries=0
	while [ ! -f "$dir/status" ] && [ -z "$agent_pid" ] &&
		[ "$tries" -lt 50 ] && turn_running; do
		sleep 0.1
		tries=$((tries + 1))
		agent_pid=$(read_file "$dir/agent_pid")
	done
	if [ ! -f "$dir/status" ] && [ -n "$agent_pid" ] && kill -0 "$agent_pid" 2>/dev/null; then
		# SIGINT is the signal behind Claude Code's documented Ctrl-C interrupt.
		# Give the CLI a chance to cancel its request and clean up tool processes
		# before its supervisor exits naturally.
		kill -INT "$agent_pid" 2>/dev/null || true
	fi
	# Do not destroy tmux as a fallback: it is the proof that the CLI and this
	# turn's supervisor have completed their own cleanup. The no-tmux path uses
	# the detached launcher's pid as the same proof. A stuck agent is a failed
	# stop, not a successful one that silently leaves work behind.
	tries=0
	while [ "$tries" -lt 300 ] && supervisor_running; do
		sleep 0.1
		tries=$((tries + 1))
	done
	if supervisor_running; then
		echo "pabloagent: turn did not exit within 30 seconds of its interrupt" >&2
		exit 8
	fi
	# A turn killed mid-flight never writes its own status, and without one a
	# poll would report it as neither running nor finished.
	[ -f "$dir/status" ] || echo 130 >"$dir/status"
	release_lock
	echo PT_STOPPED
	;;
*)
	usage
	;;
esac
