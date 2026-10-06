#!/usr/bin/env bash
# Starts, runs, or stops the app-storyboard server. Every command first asks the
# /health endpoint on the last used port whether app-storyboard is running there.
set -euo pipefail

readonly APP="app-storyboard"
readonly DATA_DIR="data"
readonly CONFIG_FILE="config/server.env"
readonly PORT_FILE=".app-storyboard.port"
readonly LOG_FILE=".app-storyboard.log"
readonly MIN_PORT=10000
readonly MAX_PORT=30000

fail() {
	printf "\033[31m✗ Error: %s\033[0m\n" "$1"
	echo ""
	exit 1
}

# Prints the pid that app-storyboard reports on /health at port $1, or nothing when
# nothing answers there. Fails when the answer comes from a different app.
running_pid() {
	local health
	if ! health=$(curl --silent --fail --max-time 2 "http://127.0.0.1:$1/health"); then
		return 0
	fi
	node -e '
		const [health, app] = process.argv.slice(1)
		let reported
		try { reported = JSON.parse(health) } catch { process.exit(1) }
		if (reported?.app !== app || !Number.isInteger(reported.pid)) process.exit(1)
		console.log(reported.pid)
	' "$health" "$APP"
}

# Sets RUNNING_PORT and RUNNING_PID to the app-storyboard instance that answers /health
# on the last used port; both stay empty when it is not running.
find_running() {
	RUNNING_PORT=""
	RUNNING_PID=""
	if [ ! -f "$PORT_FILE" ]; then
		return 0
	fi
	local port pid
	port=$(<"$PORT_FILE")
	if ! pid=$(running_pid "$port"); then
		fail "port $port answers /health, but not as $APP"
	fi
	if [ -z "$pid" ]; then
		rm -f "$PORT_FILE"
		return 0
	fi
	RUNNING_PORT=$port
	RUNNING_PID=$pid
}

stop_running() {
	find_running
	if [ -z "$RUNNING_PID" ]; then
		printf "  %s is not running\n" "$APP"
		return 0
	fi
	printf "  stopping %s (pid %s) on port %s\n" "$APP" "$RUNNING_PID" "$RUNNING_PORT"
	kill "$RUNNING_PID"
	for _ in $(seq 50); do
		if [ -z "$(running_pid "$RUNNING_PORT")" ]; then
			rm -f "$PORT_FILE"
			printf "  %s stopped\n" "$APP"
			return 0
		fi
		sleep 0.1
	done
	fail "$APP (pid $RUNNING_PID) still answers /health on port $RUNNING_PORT"
}

# Sets LMSTUDIO_URL from the config file, which must name it.
read_config() {
	if [ ! -f "$CONFIG_FILE" ]; then
		fail "$CONFIG_FILE is missing"
	fi
	LMSTUDIO_URL=$(sed -n 's/^LMSTUDIO_URL=//p' "$CONFIG_FILE")
	if [ -z "$LMSTUDIO_URL" ]; then
		fail "$CONFIG_FILE does not set LMSTUDIO_URL"
	fi
	printf "  LM Studio at %s (from %s)\n" "$LMSTUDIO_URL" "$CONFIG_FILE"
}

random_port() {
	echo $((MIN_PORT + RANDOM % (MAX_PORT - MIN_PORT + 1)))
}

# Waits until the server with pid $2 answers /health on port $1, records the port for
# the next start or stop, and opens the UI two seconds later.
await_ready() {
	local port=$1 server_pid=$2
	for _ in $(seq 100); do
		if ! kill -0 "$server_pid" 2>/dev/null; then
			fail "$APP exited during startup"
		fi
		if [ -n "$(running_pid "$port")" ]; then
			echo "$port" >"$PORT_FILE"
			printf "  %s is running at http://127.0.0.1:%s/ (pid %s)\n" "$APP" "$port" "$server_pid"
			sleep 2
			open "http://127.0.0.1:$port/"
			return 0
		fi
		sleep 0.1
	done
	kill "$server_pid"
	fail "$APP did not answer /health on port $port within 10 seconds"
}

# Starts the built server in the background; its output goes to the log file.
start() {
	read_config
	stop_running
	local port
	port=$(random_port)
	printf "  logging to %s\n" "$LOG_FILE"
	nohup node dist/index.js serve --port "$port" --data "$DATA_DIR" --lmstudio "$LMSTUDIO_URL" >>"$LOG_FILE" 2>&1 &
	await_ready "$port" $!
}

# Runs the server from source in the foreground until Ctrl-C. When app-storyboard is
# already running, opens that instance instead of starting another one.
run() {
	find_running
	if [ -n "$RUNNING_PID" ]; then
		printf "  %s is already running at http://127.0.0.1:%s/ (pid %s)\n" "$APP" "$RUNNING_PORT" "$RUNNING_PID"
		open "http://127.0.0.1:$RUNNING_PORT/"
		return 0
	fi
	read_config
	local port server_pid
	port=$(random_port)
	node --import tsx src/index.ts serve --port "$port" --data "$DATA_DIR" --lmstudio "$LMSTUDIO_URL" &
	server_pid=$!
	# Background jobs of a script ignore Ctrl-C, so the script passes it on.
	trap 'kill "$server_pid" 2>/dev/null || true' INT TERM
	await_ready "$port" "$server_pid"
	printf "  press Ctrl-C to stop\n"
	while kill -0 "$server_pid" 2>/dev/null; do
		wait "$server_pid" || true
	done
	rm -f "$PORT_FILE"
	printf "  %s stopped\n" "$APP"
}

case "${1:-}" in
start) start ;;
run) run ;;
stop) stop_running ;;
*) fail "usage: scripts/server.sh start|run|stop" ;;
esac
