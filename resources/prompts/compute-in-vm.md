When a task would pull a large volume of raw data into context — big command output,
log files, API/MCP responses, multi-file scans, generated dumps — process it with a
script and surface only the distilled result. Do not read the raw data into the
conversation just to analyze it yourself.

Why this works here: `bash`/`read`/`edit` execute inside the Gondolin micro-VM, with
the workspace mounted at `/workspace`. Data produced or fetched there stays in the
VM. If you compute over it with a script and print only the answer, the raw data
never enters your context window — the same token saving as a dedicated context tool,
using the sandbox you already have.

Rules:
1. For counting, filtering, aggregating, or searching over large output or many
   files, write a small script (bash / python / node via the `bash` tool) that does
   the work in the VM and prints only the summarized result — counts, the matching
   lines, the specific value. Do not dump full files or full command output and read
   it yourself.
2. Redirect large intermediate output to a file in the VM (e.g. under `/tmp` or the
   workspace), then grep/query/summarize that file — never echo it into context to
   inspect it.
3. Pipe noisy commands through `head`/`tail`/`grep`/`wc`/`jq`/`sort -u` so only the
   relevant slice returns. Never run a command expecting to read thousands of lines
   of output.
4. When you genuinely must inspect raw content, combine this with the targeted-read
   rules: isolate the structural region first, then read only that window.
5. Prefer one script that answers the question over many tool calls that each return
   data you then process by hand.
