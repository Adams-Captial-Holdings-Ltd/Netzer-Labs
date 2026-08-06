/**
 * The guided-tour script: every tab, in sidebar order, in plain language.
 *
 * Copy rules (this is the one place a brand-new, non-technical user gets the
 * product explained to them):
 *  - Say what a thing IS and WHEN you'd use it, not how it's implemented.
 *  - No jargon: no "RAG", "chunks", "DDB", "SSE", "capability". Where the UI
 *    itself shows a term of art (Kill Switch, DLP), define it in one sentence.
 *  - Each tab opens on its sidebar entry (target `nav:<route>`) so the user
 *    always learns WHERE the page lives before seeing what's on it.
 *
 * `capability` mirrors the Sidebar minCapability / App.tsx route gate exactly,
 * so the tour never walks someone into a page they can't open.
 * `target` is a data-tour anchor (fallback: data-testid, then CSS selector).
 * `optional: true` steps vanish silently when their element isn't on screen
 * (permission- or data-dependent controls), so the tour never strands anyone.
 */

export interface TourStep {
  /** data-tour anchor to spotlight; omitted = centered card. */
  target?: string;
  title: string;
  body: string;
  /** Skip silently when the target never appears (permission/data dependent). */
  optional?: boolean;
}

export interface TourTab {
  route: string;
  label: string;
  /** Mirror of the Sidebar minCapability for this tab (omitted = everyone). */
  capability?: string;
  steps: TourStep[];
}

export const TOUR_TABS: TourTab[] = [
  {
    route: '/',
    label: 'Overview',
    capability: 'overview:read',
    steps: [
      {
        target: 'nav:/',
        title: 'Your home page',
        body: 'Overview is the first thing you see when you sign in. It answers one question, "is everything okay right now?", without you having to dig. The sidebar on the left is how you reach every other page, and this tour will walk through each one.',
      },
      {
        target: 'overview-stats',
        title: 'The four numbers that matter',
        body: 'Today\'s spend in dollars, how many agents are switched on, how many conversations happened in the last day, and whether any emergency switches are flipped. If all four look normal, you\'re fine.',
        optional: true,
      },
      {
        target: 'overview-quick-actions',
        title: 'Shortcuts to common jobs',
        body: 'One-click jumps to the things people do most, creating an agent, opening a group discussion with agents, or checking the activity log.',
        optional: true,
      },
      {
        target: 'overview-sessions-card',
        title: 'What just happened',
        body: 'The most recent conversations across all your agents, so you can spot-check what they\'ve been saying without leaving the home page.',
        optional: true,
      },
    ],
  },
  {
    route: '/agents',
    label: 'Agents',
    capability: 'agents:read',
    steps: [
      {
        target: 'nav:/agents',
        title: 'Meet your agents',
        body: 'An agent is an AI assistant you set up once and then talk to on Telegram, Slack, or right here in the dashboard. Each one has its own personality, knowledge, and connections. This page is where they are created and managed.',
      },
      {
        target: 'agents-new-button',
        title: 'Creating an agent',
        body: 'This walks you through a short wizard, pick a name, choose the AI model that powers it, and then connect it to a channel like Telegram or Slack. An agent answers nothing until you switch it on.',
        optional: true,
      },
      {
        target: 'agents-grid',
        title: 'Your fleet at a glance',
        body: 'Every agent is a card. The toggle turns it on or off instantly, and clicking a card opens that agent\'s own page, where you set its instructions, watch its conversations, and manage its connections. A few starter agents are built in and can\'t be deleted.',
        optional: true,
      },
      {
        target: 'agents-filters',
        title: 'Finding one fast',
        body: 'Once you have more than a handful, search by name or show only the ones that are switched on.',
        optional: true,
      },
    ],
  },
  {
    route: '/chat',
    label: 'Chat',
    capability: 'chat:read',
    steps: [
      {
        target: 'nav:/chat',
        title: 'Talk to an agent',
        body: 'Chat is the fastest way to try an agent yourself, before (or instead of) connecting it to Telegram or Slack. It\'s a real conversation with the real agent, the same brain your customers would talk to.',
      },
      {
        target: 'chat-agent-picker',
        title: 'Pick who you\'re talking to',
        body: 'Choose any agent that\'s switched on. Each agent keeps its own separate conversation, so switching agents never mixes things up.',
        optional: true,
      },
      {
        target: 'chat-input',
        title: 'Just type',
        body: 'Ask anything. The reply streams in live, and if something goes wrong (a safety switch, a spending cap), you get a plain-English explanation instead of silence.',
        optional: true,
      },
      {
        target: 'chat-new-chat',
        title: 'Start fresh anytime',
        body: '"New chat" wipes the slate so the agent forgets the current thread and starts over. Handy when you want to test how it greets someone new.',
        optional: true,
      },
    ],
  },
  {
    route: '/playground',
    label: 'Playground',
    capability: 'chat:read',
    steps: [
      {
        target: 'nav:/playground',
        title: 'Compare AI models',
        body: 'The Playground sends one question to several AI models at once so you can compare their answers, speed, and price side by side. Useful when you\'re deciding which model an agent should run on.',
      },
      {
        target: 'playground-prompt',
        title: 'One prompt for everyone',
        body: 'Whatever you type here goes to every model you tick below, word for word. These are raw model calls, no agent personality or documents attached, so you\'re comparing the engines themselves.',
      },
      {
        target: 'playground-model-picker',
        title: 'Choose the contenders',
        body: 'Tick as many models as you like, from Claude to other providers. Keep in mind each ticked model is a separate paid call, so "Select all" costs more than picking two or three.',
      },
      {
        target: 'playground-run-button',
        title: 'Run the race',
        body: 'Results come back as side-by-side columns showing each model\'s answer, how long it took, and what it cost. The differences are often bigger than people expect.',
        optional: true,
      },
    ],
  },
  {
    route: '/jarvis',
    label: 'Jarvis',
    steps: [
      {
        target: 'nav:/jarvis',
        title: 'Your built-in guide',
        body: 'Jarvis is the dashboard\'s own assistant. Ask it questions in plain language, "which agents are unhealthy?", "what did we spend today?", and it looks at your live data and answers. It can show you around, but it can never change anything.',
      },
      {
        target: 'jarvis-orb',
        title: 'Talk out loud',
        body: 'Tap the orb to start a voice conversation, and tap again to stop. If you\'d rather not talk, there\'s a type-to-Jarvis box below it that does exactly the same thing.',
        optional: true,
      },
      {
        target: 'jarvis-pills',
        title: 'Good first questions',
        body: 'Not sure what to ask? These starters show what Jarvis is good at. It can also jump you to the right page and point at things on screen while it explains.',
        optional: true,
      },
    ],
  },
  {
    route: '/sessions',
    label: 'Sessions',
    capability: 'sessions:read',
    steps: [
      {
        target: 'nav:/sessions',
        title: 'Every conversation, logged',
        body: 'A session is one conversation between a person and one of your agents, on any channel. This page lists them all so you can see what your agents have actually been saying on your behalf.',
      },
      {
        target: 'sessions-table',
        title: 'Read any transcript',
        body: 'Click a row and the full back-and-forth opens right there. This is your answer to "what did the agent tell that customer?"',
      },
      {
        target: 'sessions-controls',
        title: 'Filter and export',
        body: 'Narrow the list to one agent, or download everything as a spreadsheet. Note the download always includes all agents, not just the filtered view.',
        optional: true,
      },
    ],
  },
  {
    route: '/usage',
    label: 'Usage',
    capability: 'usage:read',
    steps: [
      {
        target: 'nav:/usage',
        title: 'How much you\'re using',
        body: 'Usage shows the work your agents have done, how many AI calls, and what each one cost, day by day. This is the page for "where is the money going?" at the agent level.',
      },
      {
        target: 'usage-stats',
        title: 'The totals',
        body: 'Total spend, words in, words out, and the average cost per call, for whatever time window you pick. "Tokens" are how AI usage is measured, roughly three-quarters of a word each.',
        optional: true,
      },
      {
        target: 'usage-controls',
        title: 'Slice it your way',
        body: 'Look at one agent or all of them, zoom from today out to 30 days, and download the raw numbers as a spreadsheet.',
        optional: true,
      },
      {
        target: 'usage-daily-cap',
        title: 'Your daily safety net',
        body: 'This bar shows today\'s spending against the daily cap. The cap covers the whole fleet, not just the agent you\'ve selected above. When it fills up, agents stop spending until tomorrow.',
        optional: true,
      },
    ],
  },
  {
    route: '/cost',
    label: 'Cost',
    capability: 'cost:write',
    steps: [
      {
        target: 'nav:/cost',
        title: 'Your cloud bill, watched',
        body: 'Where Usage tracks what agents spend on AI, this page watches the real cloud bill underneath everything, including waste that has nothing to do with AI.',
      },
      {
        target: 'cost-stats',
        title: 'This month in four numbers',
        body: 'What you\'ve spent so far, where the month is projected to land, last month for comparison, and how much the waste scanner thinks you could get back.',
        optional: true,
      },
      {
        target: 'cost-cap',
        title: 'Set the spending cap',
        body: 'The single most important control on this page. Set a daily dollar limit and every agent respects it, when the cap is hit, spending stops until tomorrow. Start low; you can always raise it.',
        optional: true,
      },
      {
        target: 'cost-risks',
        title: 'Found money',
        body: 'The scanner lists cloud resources you\'re paying for but not using. Be careful here, the Apply buttons take real action on your cloud account, and some (like deleting storage) can\'t be undone.',
        optional: true,
      },
      {
        target: 'cost-report',
        title: 'A report a human can read',
        body: 'Generates a plain-English analysis of your spending, what drove it, what\'s hidden, and what to change, ranked by impact.',
        optional: true,
      },
    ],
  },
  {
    route: '/audit',
    label: 'Audit Log',
    capability: 'audit:read',
    steps: [
      {
        target: 'nav:/audit',
        title: 'Who did what, when',
        body: 'Every meaningful action in this product, by a person or an agent, is written down here permanently. If you ever need to answer "who changed that?" or "why did the agent do that?", this is the page.',
      },
      {
        target: 'audit-table',
        title: 'Click for the full story',
        body: 'Each row expands into the complete record, who acted, what happened, what it cost, and whether it succeeded.',
      },
      {
        target: 'audit-filters',
        title: 'Cut through the noise',
        body: 'Search for a name, an agent, or an action type. One thing to know, the spreadsheet download honors the time window but ignores these search filters, so it always exports the full window.',
        optional: true,
      },
    ],
  },
  {
    route: '/kill-switches',
    label: 'Kill Switches',
    capability: 'security:write',
    steps: [
      {
        target: 'nav:/kill-switches',
        title: 'Emergency off switches',
        body: 'A kill switch instantly turns off one specific ability, fleet-wide, sending messages, spending money, reading documents. Nothing is deleted, flip it back and things resume.',
      },
      {
        target: 'kill-switches-group',
        title: 'Green means running',
        body: 'Every card is one ability. Green means it\'s running normally; flip it off and every agent respects the block within about 30 seconds. Turning something off asks you to type the switch name first, so it can\'t happen by accident.',
        optional: true,
      },
      {
        target: 'kill-switches-search',
        title: 'Find the right switch fast',
        body: 'In a real incident you won\'t want to scroll. Type what you\'re worried about, "telegram", "spend", "memory", and the list narrows instantly.',
        optional: true,
      },
    ],
  },
  {
    route: '/dlp',
    label: 'DLP & Exfil',
    capability: 'security:write',
    steps: [
      {
        target: 'nav:/dlp',
        title: 'Stop secrets from leaking',
        body: 'This guard reads everything agents send out and blocks messages containing things that look like passwords, keys, or other sensitive data. DLP stands for "data loss prevention".',
      },
      {
        target: 'dlp-patterns',
        title: 'What it looks for',
        body: 'The built-in patterns cover the usual suspects. "Blocks" severity stops the message cold; "warn" lets it through but records it. You can add your own patterns below for things specific to your company.',
      },
      {
        target: 'dlp-test',
        title: 'Try before you trust',
        body: 'Paste any text here and see exactly what the guard would do with it. A "clean" verdict only means something when the guard is switched on, the page warns you in amber if it isn\'t.',
        optional: true,
      },
    ],
  },
  {
    route: '/panic',
    label: 'Panic',
    capability: 'security:write',
    steps: [
      {
        target: 'nav:/panic',
        title: 'The big red button',
        body: 'Panic stops everything at once, every agent, every channel, by flipping all the kill switches together. Use it when something is going badly wrong and you need time to think. It is fully reversible.',
      },
      {
        target: 'panic-status',
        title: 'Calm or stopped',
        body: 'This card always tells you which state you\'re in. Engaging panic first takes a snapshot of how everything was set, so releasing it later puts every switch back exactly as it was, not just "all on".',
        optional: true,
      },
      {
        target: 'panic-engage',
        title: 'Engaging it',
        body: 'Write a sentence about why (your future self will thank you), then flip the switch. You\'ll be asked to type PANIC to confirm, this is not a button you can fat-finger.',
        optional: true,
      },
      {
        target: 'panic-restore',
        title: 'Two ways back',
        body: '"Restore" puts switches back to the snapshot taken when panic was engaged, that\'s the normal path. "Force release" clears everything to off and ignores the snapshot, the escape hatch if the snapshot itself was bad.',
        optional: true,
      },
    ],
  },
  {
    route: '/rate-limits',
    label: 'Rate Limits',
    capability: 'security:write',
    steps: [
      {
        target: 'nav:/rate-limits',
        title: 'Speed limits for agents',
        body: 'Rate limits cap how many messages a single person or agent can send in a burst, so one runaway conversation can\'t hog the system or run up costs.',
      },
      {
        target: 'rate-limits-policy',
        title: 'Set the policy',
        body: 'Pick a scope (per person, per agent, or the scheduler), then set how many requests are allowed in a window. One quirk worth knowing, a limit of 0 means unlimited, not "block everything".',
      },
      {
        target: 'rate-limits-usage',
        title: 'Check on someone',
        body: 'Type an exact identity and see their live counter, or reset it if someone got stuck behind the limit. Changes take about 30 seconds to reach everywhere.',
        optional: true,
      },
    ],
  },
  {
    route: '/security-posture',
    label: 'Security Posture',
    capability: 'posture:read',
    steps: [
      {
        target: 'nav:/security-posture',
        title: 'Is the foundation secure?',
        body: 'This page inspects the cloud infrastructure underneath the product, network walls, encryption, who-can-do-what permissions, monitoring, and grades each piece. It\'s read-only, a health report, not a control panel.',
      },
      {
        target: 'posture-tabs',
        title: 'Four areas, one habit',
        body: 'Network, encryption, permissions, and monitoring each get a tab. You don\'t need to understand every check, the habit that matters is scanning for anything not green.',
      },
      {
        target: 'posture-cards',
        title: 'Reading the cards',
        body: 'Green is healthy, amber needs attention, red is a problem. Grey means "couldn\'t check", which is worth a second look, it does not mean "passed".',
        optional: true,
      },
    ],
  },
  {
    route: '/compliance',
    label: 'Compliance',
    capability: 'compliance:read',
    steps: [
      {
        target: 'nav:/compliance',
        title: 'Audit-readiness, scored',
        body: 'Compliance checks your setup against SOC 2 and HIPAA, the two checklists auditors and enterprise customers ask about, using live evidence from your actual cloud setup, not a questionnaire.',
      },
      {
        target: 'compliance-score',
        title: 'Your score',
        body: 'The percentage counts only what can be verified automatically. Blue "manual" items need a human to attest, they\'re listed but deliberately kept out of the score so it stays honest.',
        optional: true,
      },
      {
        target: 'compliance-brief',
        title: 'From gap to fix',
        body: 'This builds a ready-to-use remediation plan from whatever gaps were found, written so you can hand it straight to your engineer (or to Claude Code) to fix. Re-scan afterwards to watch the score move.',
        optional: true,
      },
    ],
  },
  {
    route: '/alerting',
    label: 'Alerting',
    capability: 'security:write',
    steps: [
      {
        target: 'nav:/alerting',
        title: 'Get emailed when things break',
        body: 'Alerting sends an email to people you choose when something important happens, costs spiking, a system check failing. Add yourself here so problems find you instead of waiting to be found.',
      },
      {
        target: 'alerting-subscribe',
        title: 'Add a recipient',
        body: 'Type an email and subscribe. One crucial detail, the recipient gets a confirmation email from AWS and receives nothing until they click the link inside it.',
      },
      {
        target: 'alerting-recipients',
        title: 'Amber means waiting',
        body: '"Pending confirmation" means the person hasn\'t clicked their confirmation link yet. Hit Refresh after they do, and use Remove to stop someone\'s alerts.',
        optional: true,
      },
      {
        target: 'alerting-alarms',
        title: 'What triggers the emails',
        body: 'These are the conditions being watched. "OK" is good news, "In alarm" means that condition is firing right now. This list is informational, the alarms themselves are managed in the cloud console.',
        optional: true,
      },
    ],
  },
  {
    route: '/integrations',
    label: 'Integrations',
    capability: 'integrations:read',
    steps: [
      {
        target: 'nav:/integrations',
        title: 'Your connections, health-checked',
        body: 'A read-only health check of everything this product is plugged into, Telegram bots, Slack apps, stored credentials, so you can confirm connections are alive and safely stored.',
      },
      {
        target: 'integrations-catalog',
        title: 'Hook up the tools you already use',
        body: 'Slack, Salesforce, Jira, Zendesk and a dozen more. Each tile opens the AWS gateway wizard where you pick the provider and attach its OAuth client, about a two-minute setup per tool. Tokens stay in AWS\'s secure vault, they never touch this product\'s database.',
      },
      {
        target: 'integrations-mcp',
        title: 'Live tools for your agents',
        body: 'Connect an MCP server here (like your AgentCore gateway) and its tools are offered to agents on every turn, from Telegram, Slack, or this dashboard. "Test tools" pings the server live so you can confirm what agents will see.',
        optional: true,
      },
      {
        target: 'integrations-table',
        title: 'One row per connection',
        body: 'The badge to watch for is "soft bypass risk", it means that connection isn\'t verifying that incoming messages are genuine. The link on the row takes you to the agent\'s page where you fix it by adding a signing secret.',
      },
      {
        target: 'integrations-secrets',
        title: 'Stored credentials',
        body: 'The bot tokens and keys this product holds, shown as status-only cards. The actual secret values are never displayed, this just confirms they exist and shows when they were last rotated.',
        optional: true,
      },
    ],
  },
  {
    route: '/vectors',
    label: 'Knowledge',
    capability: 'vectors:read',
    steps: [
      {
        target: 'nav:/vectors',
        title: 'Teach agents your documents',
        body: 'Upload PDFs, Word docs, slides, even audio recordings, and your agents can answer questions from them, citing the exact page they got the answer from.',
      },
      {
        target: 'knowledge-scope',
        title: 'Who gets to know it',
        body: 'A document\'s scope decides which agents can use it. "Shared" means every agent, or pick one agent for things only it should know. Everything else on this page follows this dropdown.',
      },
      {
        target: 'knowledge-upload',
        title: 'Drop files here',
        body: 'Drag a file in and watch it process. A progress card tracks each stage, and you\'ll be told clearly if a file fails rather than it disappearing silently.',
      },
      {
        target: 'knowledge-test',
        title: 'Check what they\'d find',
        body: 'Type a question a customer might ask and see exactly which passages an agent would pull from your documents to answer it. If the right passage doesn\'t show up, you know to upload better material.',
        optional: true,
      },
      {
        target: 'knowledge-docs',
        title: 'Your library',
        body: 'Everything uploaded into this scope, with a delete button per document. Deleting removes it from the agents\' knowledge immediately.',
        optional: true,
      },
    ],
  },
  {
    route: '/missions',
    label: 'Missions',
    capability: 'missions:read',
    steps: [
      {
        target: 'nav:/missions',
        title: 'A to-do board for agents',
        body: 'Missions is a task board, like Trello, where work items move from Open to In Progress to Done. The difference is that agents, not just people, pick up and complete the tasks.',
      },
      {
        target: 'missions-controls',
        title: 'Create and assign',
        body: 'Create a mission and either assign it to a specific agent or leave the assignee blank, in which case an AI picks the best-suited agent for you. The board view follows whichever agent you select here, or choose "All agents" to see everything.',
      },
      {
        target: 'missions-board',
        title: 'Moving work along',
        body: 'Click any card for details, and use the buttons on it to start, complete, cancel, or reopen the work. It\'s a shared source of truth for what the fleet is doing.',
        optional: true,
      },
    ],
  },
  {
    route: '/memories',
    label: 'Memories',
    capability: 'memories:read',
    steps: [
      {
        target: 'nav:/memories',
        title: 'What agents remember',
        body: 'Agents remember useful facts from conversations ("Emmanuel prefers morning meetings") so they get more helpful over time. This page lets you read exactly what they\'ve kept, transparency into the AI\'s notebook.',
      },
      {
        target: 'memories-agent-select',
        title: 'Pick an agent',
        body: 'Memories are kept per agent, per conversation. Choose the agent you\'re curious about first.',
        optional: true,
      },
      {
        target: 'memories-sessions',
        title: 'Then pick a conversation',
        body: 'Click any conversation card and the facts the agent saved from it appear, each with a timestamp and how important the agent judged it. Reading is all you can do here, this page never edits.',
        optional: true,
      },
    ],
  },
  {
    route: '/hive',
    label: 'Hive Mind',
    capability: 'hive:read',
    steps: [
      {
        target: 'nav:/hive',
        title: 'Shared knowledge between agents',
        body: 'When one agent learns something useful for everyone, it gets promoted here automatically, to the hive, so every other agent knows it too. Think of it as the fleet\'s shared notebook.',
      },
      {
        target: 'hive-feed',
        title: 'What\'s been shared',
        body: 'Each note shows which agent contributed it and what it\'s about. There\'s deliberately no "add" button, the fleet fills this in on its own as it learns.',
        optional: true,
      },
      {
        target: 'hive-cadence',
        title: 'How often it learns',
        body: 'These settings control how often agents scan for share-worthy facts and how confident they must be before promoting one. The defaults are sensible, most people never touch this.',
        optional: true,
      },
    ],
  },
  {
    route: '/scheduled',
    label: 'Scheduled',
    capability: 'scheduled:read',
    steps: [
      {
        target: 'nav:/scheduled',
        title: 'Things agents do on a timer',
        body: 'Agents can take on recurring jobs, a morning summary, an hourly check. You don\'t create those here, you ask the agent in chat ("send me a digest every morning") and the job appears on this page.',
      },
      {
        target: 'scheduled-table',
        title: 'Watch and cancel',
        body: 'Each row shows what the job does, how often, and when it runs next. Cancel removes a job for good, the agent won\'t recreate it unless you ask again.',
      },
    ],
  },
  {
    route: '/warroom',
    label: 'War Room',
    capability: 'warroom:read',
    steps: [
      {
        target: 'nav:/warroom',
        title: 'Group chat with several agents',
        body: 'A war room is a meeting where multiple agents discuss a problem together and you moderate. Great for getting different perspectives, one agent drafts, another critiques.',
      },
      {
        target: 'warroom-new-room',
        title: 'Start a discussion',
        body: 'Give it a topic, pick which agents attend, and create. The room opens immediately and the agents are ready to talk.',
      },
      {
        target: 'warroom-composer',
        title: 'Address the room, or one agent',
        body: 'Type @ and an agent\'s name to ask them specifically, or @all for everyone. An untagged message goes to all participants. Each agent types its reply like a person would.',
        optional: true,
      },
      {
        target: 'warroom-rooms',
        title: 'Rooms keep their history',
        body: 'Past rooms live here as permanent transcripts. "End session" freezes a room read-only when the discussion is done; delete removes it entirely.',
        optional: true,
      },
    ],
  },
  {
    route: '/members',
    label: 'Members',
    capability: 'members:read',
    steps: [
      {
        target: 'nav:/members',
        title: 'Who can sign in',
        body: 'Invite teammates by email and control what each person is allowed to see and do, from view-only access up to full administration.',
      },
      {
        target: 'members-table',
        title: 'The team list',
        body: 'Everyone with access, their role, and when they last signed in. From here you can change someone\'s role, disable them (which also signs them out everywhere, instantly), or re-invite someone who was disabled.',
      },
      {
        target: 'members-profiles',
        title: 'Roles, made of permissions',
        body: 'A role is just a bundle of permissions. The templates (viewer, operator, admin) cover most teams, but you can build a custom role that grants exactly the pages and actions you want, nothing more.',
        optional: true,
      },
    ],
  },
  {
    route: '/settings',
    label: 'Settings',
    steps: [
      {
        target: 'nav:/settings',
        title: 'Your account and product settings',
        body: 'Everything personal and global lives here. Worth knowing, most of the editable controls on this page are admin-only; everyone else sees their current values without the edit buttons.',
      },
      {
        target: 'settings-cost-cap',
        title: 'The daily cost cap',
        body: 'The same spending cap you saw on the Cost page, shown here with today\'s progress. One number protects the whole fleet.',
        optional: true,
      },
      {
        target: 'settings-themes',
        title: 'Make it yours',
        body: 'Upload your logo, set your brand colors and tagline, and the whole dashboard re-skins instantly, useful if clients ever see your screen.',
        optional: true,
      },
      {
        target: 'settings-export',
        title: 'Your data, downloadable',
        body: 'Activity, usage, and conversation history as spreadsheet downloads, for an auditor, a report, or your own records.',
        optional: true,
      },
      {
        target: 'settings-tour',
        title: 'That\'s the whole product',
        body: 'You\'ve now seen every page. This card restarts the tour any time, for you or a teammate, either the full walkthrough or a single page. Welcome aboard.',
        optional: true,
      },
    ],
  },
  {
    route: '/seats',
    label: 'Seats',
    capability: 'seats:read',
    steps: [
      {
        target: 'nav:/seats',
        title: 'Seat administration',
        body: 'Bind each member to a seat policy: which models they may use, which tools, and a monthly spend limit. The usage table below shows every attributed Bedrock call with its cost and policy outcome.',
      },
    ],
  },
  {
    route: '/my-seat',
    label: 'My Seat',
    capability: 'usage:self:read',
    steps: [
      {
        target: 'nav:/my-seat',
        title: 'Your seat',
        body: 'Your own policy limits and personal usage ledger. Only your seat\'s rows are visible here, never a teammate\'s.',
      },
    ],
  },
  {
    route: '/getting-started',
    label: 'Getting Started',
    steps: [
      {
        target: 'nav:/getting-started',
        title: 'The onboarding checklist',
        body: 'A role-aware checklist from first sign-in through seats, policies, and verified usage. Come back here any time; progress is saved per account.',
      },
    ],
  },
];
