# be-service — Java code execution service

Minimal Node/Express service that compiles and runs a Java snippet inside an
isolated temp directory, then cleans up. Built to run on **Render's free tier**
via Docker (the image ships a JDK next to Node). Called only by the
`aws-learn-app` Next.js app through its server-side proxy (`/api/run-java`).

## Endpoints

### `POST /run`
Header: `x-run-secret: <RUN_JAVA_SECRET>` (required when the env var is set).

Request:
```json
{ "code": "public class Main { public static void main(String[] a){ System.out.println(\"hi\"); } }" }
```

Response:
```json
{ "stdout": "hi\n", "stderr": "", "exitCode": 0, "timedOut": false }
```

- Compile errors come back as `stderr` with a non-zero `exitCode`.
- Infinite loops are killed: `timedOut: true` with an `error` message.
- The public class **must** be named `Main`.

### `GET /health`
Returns `{ ok: true, ... }`. Used by Render health checks and any external
keep-warm pinger (e.g. UptimeRobot) to reduce free-tier cold starts.

## Guardrails
- Compile timeout 8s, run timeout 5s (both `SIGKILL` on expiry)
- `java -Xmx128m` bounds heap within the 512MB box
- stdout capped at 10 000 chars, stderr at 5 000
- Per-request unique temp dir, always removed in `finally`
- Runs as non-root `runner` user in the container
- Shared-secret header + basic per-IP rate limit

## Local dev
```bash
npm install
npm start                 # needs javac/java on PATH, or use Docker below
```

## Docker
```bash
docker build -t be-service .
docker run -p 3000:3000 -e RUN_JAVA_SECRET=dev-secret be-service

curl -s -X POST localhost:3000/run \
  -H 'content-type: application/json' \
  -H 'x-run-secret: dev-secret' \
  -d '{"code":"public class Main{public static void main(String[] a){System.out.println(\"hi\");}}"}'
```

## Deploy on Render
1. Push this repo to GitHub and create a **Web Service** → **Docker** → **Free**
   (or use `render.yaml` as a Blueprint).
2. Set `RUN_JAVA_SECRET` in the dashboard to a long random string.
3. In `aws-learn-app`, set `RUN_JAVA_URL=https://<your-service>.onrender.com/run`
   and `RUN_JAVA_SECRET` to the same value.
