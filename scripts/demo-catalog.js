'use strict';

// THE LIVE DEMO'S CATALOG — the capabilities, principals and grants ../scripts/seed-demo.js writes
// into the public Vercel + Supabase demo. docs/design/vercel-supabase-demo.md.
//
// WHY THIS IS NOT ../server/starterCatalog.js. That file is the baseline a *fresh install* boots
// with, and it is deliberately narrow: this tool's own skills, the platform's own MCP server, and
// the two Google connectors. Seeding the public demo from it would answer the wrong question. A
// visitor opening the demo is asking "what does Windrow look like pointed at MY stack" — and the
// honest answer is a hundred-odd rows owned by a dozen third-party MCP servers nobody here wrote.
// So every capability below is a REAL tool name from a REAL, publicly documented MCP server or
// Agent Skill: github-mcp-server, the Slack/filesystem/Postgres reference servers, Linear, Sentry,
// Notion, Stripe, Playwright, Figma Dev Mode, the Gmail and Google Drive connectors, and
// Anthropic's published skills. What is fabricated is the *organisation around them* — who holds
// what, who was denied, who is still pending — because that is the part a demo has to invent.
//
// NO IDS HERE, same rule and same reason as ../server/starterCatalog.js: central mints them
// (`insertCapability`), so a row is identified by the pair the unique index is on, `(kind, name)`.
// The seeder resolves every ref below through whatever id its store handed back, which is also what
// makes it idempotent against a database somebody has already seeded.
//
// (kind, name) IS UNIQUE FLEET-WIDE, AND THAT SHAPES THIS LIST. server/hooks/lib.js normalises
// `mcp__<server>__<tool>` to the bare tool name, so two MCP servers exposing the same bare name are
// ONE catalog row — GitHub's `create_issue` and Linear's are indistinguishable to the registry, and
// so are the filesystem server's `search_files` and Google Drive's. Rather than invent
// disambiguated names that no hook would ever produce, the sets below are chosen so each collision
// is resolved in favour of one owner, and the loser's colliding tools are simply left out. Those
// omissions are marked where they happen; they are a real property of the data model, not a gap.

const { capRef } = require('../server/starterCatalog');

// ---------------------------------------------------------------------------------------------
// Capabilities
//
// `addedDaysAgo` is not a column — the seeder uses it to backdate `createdAt` after the insert, so
// the catalog reads as something that accumulated over two quarters rather than as a hundred rows
// that all appeared in the same second. A demo whose every timestamp is identical is a demo that
// announces itself as a fixture on the first page anybody opens.
// ---------------------------------------------------------------------------------------------
const CAPABILITIES = [
  // ---- GitHub — github/github-mcp-server --------------------------------------------------
  { kind: 'mcp_tool', name: 'get_me', owner: 'github', riskTier: 'read_only', addedDaysAgo: 168, description: 'Details of the authenticated GitHub user.' },
  { kind: 'mcp_tool', name: 'search_repositories', owner: 'github', riskTier: 'read_only', addedDaysAgo: 168, description: 'Search GitHub repositories.' },
  { kind: 'mcp_tool', name: 'get_file_contents', owner: 'github', riskTier: 'read_only', addedDaysAgo: 168, description: 'Read a file or directory from a GitHub repository.' },
  { kind: 'mcp_tool', name: 'list_commits', owner: 'github', riskTier: 'read_only', addedDaysAgo: 168, description: 'List commits on a branch.' },
  { kind: 'mcp_tool', name: 'list_pull_requests', owner: 'github', riskTier: 'read_only', addedDaysAgo: 168, description: 'List pull requests on a repository.' },
  { kind: 'mcp_tool', name: 'get_pull_request_diff', owner: 'github', riskTier: 'read_only', addedDaysAgo: 161, description: 'The unified diff of a pull request.' },
  { kind: 'mcp_tool', name: 'list_workflow_runs', owner: 'github', riskTier: 'read_only', addedDaysAgo: 96, description: 'List GitHub Actions workflow runs.' },
  { kind: 'mcp_tool', name: 'create_issue', owner: 'github', riskTier: 'mutating', addedDaysAgo: 168, description: 'Open a GitHub issue.' },
  { kind: 'mcp_tool', name: 'add_issue_comment', owner: 'github', riskTier: 'mutating', addedDaysAgo: 168, description: 'Comment on a GitHub issue or pull request.' },
  { kind: 'mcp_tool', name: 'create_pull_request', owner: 'github', riskTier: 'mutating', addedDaysAgo: 161, description: 'Open a pull request.' },
  { kind: 'mcp_tool', name: 'create_or_update_file', owner: 'github', riskTier: 'mutating', addedDaysAgo: 161, description: 'Commit a single file to a branch.' },
  { kind: 'mcp_tool', name: 'create_branch', owner: 'github', riskTier: 'mutating', addedDaysAgo: 161, description: 'Create a branch from a ref.' },
  { kind: 'mcp_tool', name: 'merge_pull_request', owner: 'github', riskTier: 'destructive', addedDaysAgo: 161, description: 'Merge a pull request into its base branch.' },
  { kind: 'mcp_tool', name: 'delete_file', owner: 'github', riskTier: 'destructive', addedDaysAgo: 96, description: 'Delete a file from a repository.' },

  // ---- Slack — the reference server, whose tool names really are `slack_`-prefixed ---------
  { kind: 'mcp_tool', name: 'slack_list_channels', owner: 'slack', riskTier: 'read_only', addedDaysAgo: 154, description: 'List public channels in the workspace.' },
  { kind: 'mcp_tool', name: 'slack_get_channel_history', owner: 'slack', riskTier: 'read_only', addedDaysAgo: 154, description: 'Recent messages in a channel.' },
  { kind: 'mcp_tool', name: 'slack_get_thread_replies', owner: 'slack', riskTier: 'read_only', addedDaysAgo: 154, description: 'Replies in a message thread.' },
  { kind: 'mcp_tool', name: 'slack_get_users', owner: 'slack', riskTier: 'read_only', addedDaysAgo: 154, description: 'List workspace members.' },
  { kind: 'mcp_tool', name: 'slack_get_user_profile', owner: 'slack', riskTier: 'read_only', addedDaysAgo: 154, description: 'A workspace member’s profile.' },
  { kind: 'mcp_tool', name: 'slack_post_message', owner: 'slack', riskTier: 'mutating', addedDaysAgo: 154, description: 'Post a message to a channel.' },
  { kind: 'mcp_tool', name: 'slack_reply_to_thread', owner: 'slack', riskTier: 'mutating', addedDaysAgo: 154, description: 'Reply in a message thread.' },
  { kind: 'mcp_tool', name: 'slack_add_reaction', owner: 'slack', riskTier: 'mutating', addedDaysAgo: 140, description: 'Add an emoji reaction to a message.' },

  // ---- Linear -----------------------------------------------------------------------------
  // `create_issue`, `list_issues` and `get_issue` are Linear tool names too, and they collide with
  // GitHub's above — one catalog row, first owner wins. GitHub holds them here, so Linear is
  // represented by the tools whose names are its own.
  { kind: 'mcp_tool', name: 'list_my_issues', owner: 'linear', riskTier: 'read_only', addedDaysAgo: 133, description: 'Issues assigned to the calling user.' },
  { kind: 'mcp_tool', name: 'list_issue_statuses', owner: 'linear', riskTier: 'read_only', addedDaysAgo: 133, description: 'Workflow states for a team.' },
  { kind: 'mcp_tool', name: 'list_teams', owner: 'linear', riskTier: 'read_only', addedDaysAgo: 133, description: 'Teams in the Linear workspace.' },
  { kind: 'mcp_tool', name: 'list_cycles', owner: 'linear', riskTier: 'read_only', addedDaysAgo: 133, description: 'Cycles for a team.' },
  { kind: 'mcp_tool', name: 'list_documents', owner: 'linear', riskTier: 'read_only', addedDaysAgo: 119, description: 'Documents in the Linear workspace.' },
  { kind: 'mcp_tool', name: 'update_issue', owner: 'linear', riskTier: 'mutating', addedDaysAgo: 133, description: 'Change an issue’s state, assignee or estimate.' },
  { kind: 'mcp_tool', name: 'create_comment', owner: 'linear', riskTier: 'mutating', addedDaysAgo: 133, description: 'Comment on a Linear issue.' },
  { kind: 'mcp_tool', name: 'create_project', owner: 'linear', riskTier: 'mutating', addedDaysAgo: 119, description: 'Create a Linear project.' },

  // ---- Sentry -----------------------------------------------------------------------------
  { kind: 'mcp_tool', name: 'find_organizations', owner: 'sentry', riskTier: 'read_only', addedDaysAgo: 112, description: 'Sentry organisations the token can see.' },
  { kind: 'mcp_tool', name: 'find_projects', owner: 'sentry', riskTier: 'read_only', addedDaysAgo: 112, description: 'Projects in a Sentry organisation.' },
  { kind: 'mcp_tool', name: 'find_issues', owner: 'sentry', riskTier: 'read_only', addedDaysAgo: 112, description: 'Search Sentry issues.' },
  { kind: 'mcp_tool', name: 'get_issue_details', owner: 'sentry', riskTier: 'read_only', addedDaysAgo: 112, description: 'Full detail and stack trace for a Sentry issue.' },
  { kind: 'mcp_tool', name: 'search_events', owner: 'sentry', riskTier: 'read_only', addedDaysAgo: 105, description: 'Query Sentry events with a natural-language search.' },
  { kind: 'mcp_tool', name: 'analyze_issue_with_seer', owner: 'sentry', riskTier: 'mutating', addedDaysAgo: 63, description: 'Start a Seer root-cause analysis on an issue.' },
  { kind: 'mcp_tool', name: 'create_dsn', owner: 'sentry', riskTier: 'mutating', addedDaysAgo: 63, description: 'Mint a new client key (DSN) for a project.' },

  // ---- Notion — the hosted connector's tool names ------------------------------------------
  { kind: 'mcp_tool', name: 'search', owner: 'notion', riskTier: 'read_only', addedDaysAgo: 98, description: 'Search Notion pages, databases and Slack/Drive connections.' },
  { kind: 'mcp_tool', name: 'fetch', owner: 'notion', riskTier: 'read_only', addedDaysAgo: 98, description: 'Fetch a Notion page or database by URL or id.' },
  { kind: 'mcp_tool', name: 'notion-get-users', owner: 'notion', riskTier: 'read_only', addedDaysAgo: 98, description: 'List members of the Notion workspace.' },
  { kind: 'mcp_tool', name: 'notion-get-comments', owner: 'notion', riskTier: 'read_only', addedDaysAgo: 98, description: 'Comments on a Notion page or block.' },
  { kind: 'mcp_tool', name: 'notion-create-pages', owner: 'notion', riskTier: 'mutating', addedDaysAgo: 98, description: 'Create one or more Notion pages.' },
  { kind: 'mcp_tool', name: 'notion-update-page', owner: 'notion', riskTier: 'mutating', addedDaysAgo: 98, description: 'Update a Notion page’s properties or content.' },
  { kind: 'mcp_tool', name: 'notion-create-comment', owner: 'notion', riskTier: 'mutating', addedDaysAgo: 91, description: 'Comment on a Notion page.' },
  { kind: 'mcp_tool', name: 'notion-move-pages', owner: 'notion', riskTier: 'destructive', addedDaysAgo: 91, description: 'Move Notion pages to another parent — or to the trash.' },

  // ---- Postgres — the reference server, one tool and one tier ------------------------------
  { kind: 'mcp_tool', name: 'query', owner: 'postgres', riskTier: 'read_only', addedDaysAgo: 147, description: 'Run a read-only SQL query against the connected database.' },

  // ---- Filesystem — the reference server ---------------------------------------------------
  // `search_files` is also a Google Drive tool name and is registered under `gdrive` below; the
  // filesystem server's copy would be the same row, so it is left out here.
  { kind: 'mcp_tool', name: 'read_text_file', owner: 'filesystem', riskTier: 'read_only', addedDaysAgo: 147, description: 'Read a text file from an allowed directory.' },
  { kind: 'mcp_tool', name: 'read_multiple_files', owner: 'filesystem', riskTier: 'read_only', addedDaysAgo: 147, description: 'Read several files in one call.' },
  { kind: 'mcp_tool', name: 'list_directory', owner: 'filesystem', riskTier: 'read_only', addedDaysAgo: 147, description: 'List the entries of a directory.' },
  { kind: 'mcp_tool', name: 'directory_tree', owner: 'filesystem', riskTier: 'read_only', addedDaysAgo: 147, description: 'Recursive tree of a directory.' },
  { kind: 'mcp_tool', name: 'get_file_info', owner: 'filesystem', riskTier: 'read_only', addedDaysAgo: 147, description: 'Size, timestamps and permissions for a path.' },
  { kind: 'mcp_tool', name: 'list_allowed_directories', owner: 'filesystem', riskTier: 'read_only', addedDaysAgo: 147, description: 'Which directories this server is permitted to touch.' },
  { kind: 'mcp_tool', name: 'write_file', owner: 'filesystem', riskTier: 'mutating', addedDaysAgo: 147, description: 'Create or overwrite a file.' },
  { kind: 'mcp_tool', name: 'edit_file', owner: 'filesystem', riskTier: 'mutating', addedDaysAgo: 147, description: 'Apply line-based edits to a file.' },
  { kind: 'mcp_tool', name: 'create_directory', owner: 'filesystem', riskTier: 'mutating', addedDaysAgo: 147, description: 'Create a directory.' },
  { kind: 'mcp_tool', name: 'move_file', owner: 'filesystem', riskTier: 'destructive', addedDaysAgo: 140, description: 'Move or rename a file — fails if the destination exists.' },

  // ---- Stripe ------------------------------------------------------------------------------
  { kind: 'mcp_tool', name: 'search_documentation', owner: 'stripe', riskTier: 'read_only', addedDaysAgo: 84, description: 'Search the Stripe developer documentation.' },
  { kind: 'mcp_tool', name: 'list_customers', owner: 'stripe', riskTier: 'read_only', addedDaysAgo: 84, description: 'List Stripe customers.' },
  { kind: 'mcp_tool', name: 'list_products', owner: 'stripe', riskTier: 'read_only', addedDaysAgo: 84, description: 'List Stripe products.' },
  { kind: 'mcp_tool', name: 'list_invoices', owner: 'stripe', riskTier: 'read_only', addedDaysAgo: 84, description: 'List Stripe invoices.' },
  { kind: 'mcp_tool', name: 'list_subscriptions', owner: 'stripe', riskTier: 'read_only', addedDaysAgo: 84, description: 'List Stripe subscriptions.' },
  { kind: 'mcp_tool', name: 'retrieve_balance', owner: 'stripe', riskTier: 'read_only', addedDaysAgo: 84, description: 'The account’s current Stripe balance.' },
  { kind: 'mcp_tool', name: 'create_customer', owner: 'stripe', riskTier: 'mutating', addedDaysAgo: 77, description: 'Create a Stripe customer.' },
  { kind: 'mcp_tool', name: 'create_payment_link', owner: 'stripe', riskTier: 'mutating', addedDaysAgo: 77, description: 'Create a shareable Stripe payment link.' },
  { kind: 'mcp_tool', name: 'create_refund', owner: 'stripe', riskTier: 'destructive', addedDaysAgo: 77, description: 'Refund a Stripe payment intent.' },
  { kind: 'mcp_tool', name: 'cancel_subscription', owner: 'stripe', riskTier: 'destructive', addedDaysAgo: 77, description: 'Cancel a Stripe subscription.' },

  // ---- Playwright --------------------------------------------------------------------------
  { kind: 'mcp_tool', name: 'browser_snapshot', owner: 'playwright', riskTier: 'read_only', addedDaysAgo: 70, description: 'Accessibility snapshot of the current page.' },
  { kind: 'mcp_tool', name: 'browser_take_screenshot', owner: 'playwright', riskTier: 'read_only', addedDaysAgo: 70, description: 'Screenshot the current page.' },
  { kind: 'mcp_tool', name: 'browser_console_messages', owner: 'playwright', riskTier: 'read_only', addedDaysAgo: 70, description: 'Console output from the page.' },
  { kind: 'mcp_tool', name: 'browser_network_requests', owner: 'playwright', riskTier: 'read_only', addedDaysAgo: 70, description: 'Network requests the page has made.' },
  { kind: 'mcp_tool', name: 'browser_navigate', owner: 'playwright', riskTier: 'mutating', addedDaysAgo: 70, description: 'Navigate the browser to a URL.' },
  { kind: 'mcp_tool', name: 'browser_click', owner: 'playwright', riskTier: 'mutating', addedDaysAgo: 70, description: 'Click an element on the page.' },
  { kind: 'mcp_tool', name: 'browser_type', owner: 'playwright', riskTier: 'mutating', addedDaysAgo: 70, description: 'Type into an element on the page.' },
  { kind: 'mcp_tool', name: 'browser_evaluate', owner: 'playwright', riskTier: 'destructive', addedDaysAgo: 56, description: 'Evaluate arbitrary JavaScript in the page.' },

  // ---- Figma Dev Mode ----------------------------------------------------------------------
  { kind: 'mcp_tool', name: 'get_code', owner: 'figma', riskTier: 'read_only', addedDaysAgo: 49, description: 'Generate code for the selected Figma frame.' },
  { kind: 'mcp_tool', name: 'get_variable_defs', owner: 'figma', riskTier: 'read_only', addedDaysAgo: 49, description: 'Design variables and tokens used by a selection.' },
  { kind: 'mcp_tool', name: 'get_image', owner: 'figma', riskTier: 'read_only', addedDaysAgo: 49, description: 'Render an image of a Figma node.' },
  { kind: 'mcp_tool', name: 'get_code_connect_map', owner: 'figma', riskTier: 'read_only', addedDaysAgo: 42, description: 'Map Figma nodes to the components they are connected to.' },

  // ---- Gmail — the claude_ai_Gmail connector -----------------------------------------------
  { kind: 'mcp_tool', name: 'search_threads', owner: 'gmail', riskTier: 'read_only', addedDaysAgo: 126, description: 'Search Gmail threads.' },
  { kind: 'mcp_tool', name: 'get_message', owner: 'gmail', riskTier: 'read_only', addedDaysAgo: 126, description: 'Read a Gmail message.' },
  { kind: 'mcp_tool', name: 'get_thread', owner: 'gmail', riskTier: 'read_only', addedDaysAgo: 126, description: 'Read a Gmail thread.' },
  { kind: 'mcp_tool', name: 'list_labels', owner: 'gmail', riskTier: 'read_only', addedDaysAgo: 126, description: 'List Gmail labels.' },
  { kind: 'mcp_tool', name: 'create_draft', owner: 'gmail', riskTier: 'mutating', addedDaysAgo: 126, description: 'Create a Gmail draft.' },
  { kind: 'mcp_tool', name: 'label_message', owner: 'gmail', riskTier: 'mutating', addedDaysAgo: 126, description: 'Apply a label to a Gmail message.' },
  { kind: 'mcp_tool', name: 'create_label', owner: 'gmail', riskTier: 'mutating', addedDaysAgo: 119, description: 'Create a Gmail label.' },
  { kind: 'mcp_tool', name: 'send_message', owner: 'gmail', riskTier: 'destructive', addedDaysAgo: 126, description: 'Send mail as the authenticated user.' },
  { kind: 'mcp_tool', name: 'trash_message', owner: 'gmail', riskTier: 'destructive', addedDaysAgo: 126, description: 'Move a Gmail message to trash.' },
  { kind: 'mcp_tool', name: 'mark_message_spam', owner: 'gmail', riskTier: 'destructive', addedDaysAgo: 119, description: 'Mark a Gmail message as spam.' },

  // ---- Google Drive — the claude_ai_Google_Drive connector ----------------------------------
  { kind: 'mcp_tool', name: 'search_files', owner: 'gdrive', riskTier: 'read_only', addedDaysAgo: 126, description: 'Search Google Drive files.' },
  { kind: 'mcp_tool', name: 'read_file_content', owner: 'gdrive', riskTier: 'read_only', addedDaysAgo: 126, description: 'Read the content of a Google Drive file.' },
  { kind: 'mcp_tool', name: 'get_file_metadata', owner: 'gdrive', riskTier: 'read_only', addedDaysAgo: 126, description: 'Metadata for a Google Drive file.' },
  { kind: 'mcp_tool', name: 'list_recent_files', owner: 'gdrive', riskTier: 'read_only', addedDaysAgo: 126, description: 'Recently modified Drive files.' },
  { kind: 'mcp_tool', name: 'get_file_permissions', owner: 'gdrive', riskTier: 'read_only', addedDaysAgo: 112, description: 'Who a Drive file is shared with.' },
  { kind: 'mcp_tool', name: 'create_file', owner: 'gdrive', riskTier: 'mutating', addedDaysAgo: 126, description: 'Create a Google Drive file.' },
  { kind: 'mcp_tool', name: 'copy_file', owner: 'gdrive', riskTier: 'mutating', addedDaysAgo: 126, description: 'Copy a Google Drive file.' },
  { kind: 'mcp_tool', name: 'update_file', owner: 'gdrive', riskTier: 'mutating', addedDaysAgo: 112, description: 'Update a Google Drive file’s content or metadata.' },
  { kind: 'mcp_tool', name: 'share_file', owner: 'gdrive', riskTier: 'destructive', addedDaysAgo: 112, description: 'Grant another account access to a Drive file.' },
  { kind: 'mcp_tool', name: 'trash_file', owner: 'gdrive', riskTier: 'destructive', addedDaysAgo: 112, description: 'Move a Google Drive file to the trash.' },

  // ---- Skills ------------------------------------------------------------------------------
  // Catalogued, never gated: a skill has no per-call hook to enforce a grant against
  // (docs/design/skill-mcp-governance.md §0), so these rows exist for discoverability ONLY. No
  // principal is granted a skill (none appear in READ_ONLY_BASELINE or GRANTS below) and no skill
  // usage event is generated (none appear in seed-demo.js's ACTORS) — a skill is a searchable index
  // entry, not a permission boundary. Their tiers still say what a skill does when it runs.
  { kind: 'skill', name: 'pdf', owner: 'anthropic', riskTier: 'mutating', addedDaysAgo: 133, description: 'Fill, merge, split and extract from PDF files.' },
  { kind: 'skill', name: 'docx', owner: 'anthropic', riskTier: 'mutating', addedDaysAgo: 133, description: 'Create and edit Word documents with tracked changes.' },
  { kind: 'skill', name: 'xlsx', owner: 'anthropic', riskTier: 'mutating', addedDaysAgo: 133, description: 'Create, read and recalculate Excel workbooks.' },
  { kind: 'skill', name: 'pptx', owner: 'anthropic', riskTier: 'mutating', addedDaysAgo: 133, description: 'Build and edit PowerPoint decks.' },
  { kind: 'skill', name: 'artifacts-builder', owner: 'anthropic', riskTier: 'mutating', addedDaysAgo: 105, description: 'Build complex React artifacts with the full component library.' },
  { kind: 'skill', name: 'canvas-design', owner: 'anthropic', riskTier: 'mutating', addedDaysAgo: 105, description: 'Design-grade poster, layout and canvas composition.' },
  { kind: 'skill', name: 'mcp-builder', owner: 'anthropic', riskTier: 'mutating', addedDaysAgo: 91, description: 'Scaffold and evaluate a new MCP server.' },
  { kind: 'skill', name: 'webapp-testing', owner: 'anthropic', riskTier: 'mutating', addedDaysAgo: 91, description: 'Drive a web app in a headless browser to verify a change.' },
  { kind: 'skill', name: 'slack-gif-creator', owner: 'anthropic', riskTier: 'mutating', addedDaysAgo: 63, description: 'Produce Slack-ready animated GIFs.' },
  { kind: 'skill', name: 'brand-guidelines', owner: 'anthropic', riskTier: 'read_only', addedDaysAgo: 105, description: 'Apply a brand’s colour, type and voice rules to generated work.' },
  { kind: 'skill', name: 'internal-comms', owner: 'anthropic', riskTier: 'read_only', addedDaysAgo: 63, description: 'Draft internal announcements in a house style.' },
  { kind: 'skill', name: 'code-review', owner: 'platform', riskTier: 'mutating', addedDaysAgo: 168, description: 'Review the current diff or PR for bugs and cleanups; can comment or apply fixes.' },
  { kind: 'skill', name: 'security-review', owner: 'platform', riskTier: 'read_only', addedDaysAgo: 168, description: 'Security review of the pending changes on the current branch.' },
  { kind: 'skill', name: 'dataviz', owner: 'platform', riskTier: 'read_only', addedDaysAgo: 154, description: 'Design guidance for charts, dashboards and data visualisation.' },
  { kind: 'skill', name: 'supabase', owner: 'supabase', riskTier: 'mutating', addedDaysAgo: 84, description: 'Supabase database, auth, edge function and migration work.' },
  { kind: 'skill', name: 'supabase-postgres-best-practices', owner: 'supabase', riskTier: 'read_only', addedDaysAgo: 84, description: 'Postgres schema, index, RLS and migration rules.' },
];

// ---------------------------------------------------------------------------------------------
// Principals
//
// THREE KINDS, and the demo shows all three because the difference between them is the part of the
// model a screenshot cannot explain (client/src/api/policy.ts): a `user` is the person a call is
// accountable to and is keyed on `subjectId`; a `role` is the agent kind that grants attach to; an
// `instance` is one running loom, which inherits its role's grants and holds none of its own.
// ---------------------------------------------------------------------------------------------

/** The people. `subjectId` is an OS security identifier, prefixed by the authority that issued it —
 *  the same `win-sid:` / `posix:` shapes ../server/principals/ mints, since the demo's usage rows
 *  carry these verbatim and central resolves a human name back through them. */
const USERS = [
  { kind: 'user', name: 'ada', humanName: 'Ada Kessler', subjectId: 'win-sid:S-1-5-21-2963-8841-70113-1104', assuranceLevel: 2, status: 'active', owner: 'platform', addedDaysAgo: 168 },
  { kind: 'user', name: 'linus', humanName: 'Linus Park', subjectId: 'posix:1000@borealis', assuranceLevel: 2, status: 'active', owner: 'platform', addedDaysAgo: 154 },
  { kind: 'user', name: 'grace', humanName: 'Grace Okafor', subjectId: 'win-sid:S-1-5-21-2963-8841-70113-1187', assuranceLevel: 2, status: 'active', owner: 'billing', addedDaysAgo: 119 },
];

/** The agent kinds. Claude Code's own subagent types plus the two other backends this workspace has
 *  adapters for; `codex` is deliberately left `pending` — a backend that has been seen and has not
 *  been approved is the state the Principals page exists to make visible. */
const ROLES = [
  { kind: 'role', name: 'claudecode', status: 'active', owner: 'platform', backend: 'claude', addedDaysAgo: 168 },
  { kind: 'role', name: 'claude', status: 'active', owner: 'platform', backend: 'claude', addedDaysAgo: 168 },
  { kind: 'role', name: 'general-purpose', status: 'active', owner: 'platform', backend: 'claude', addedDaysAgo: 168 },
  { kind: 'role', name: 'Explore', status: 'active', owner: 'platform', backend: 'claude', addedDaysAgo: 161 },
  { kind: 'role', name: 'Plan', status: 'active', owner: 'platform', backend: 'claude', addedDaysAgo: 161 },
  { kind: 'role', name: 'design-agent', status: 'active', owner: 'design', backend: 'claude', addedDaysAgo: 105 },
  { kind: 'role', name: 'claude-standalone', status: 'active', owner: 'platform', backend: 'claude', standalone: true, addedDaysAgo: 133 },
  { kind: 'role', name: 'agy', status: 'active', owner: 'platform', backend: 'agy', addedDaysAgo: 91 },
  { kind: 'role', name: 'codex', status: 'pending', owner: 'platform', backend: 'codex', addedDaysAgo: 12 },
];

/** Running looms. `name` is the loom id the hook saw, `parentRole` is where its permission comes
 *  from — an instance holds no grants of its own, which is why none appear in GRANTS below. */
const INSTANCES = [
  { kind: 'instance', name: 'claude-7fq2hb31-204', parentRole: 'claudecode', backend: 'claude', agentType: 'claudecode', field: 'checkout', status: 'active', owner: 'platform', addedDaysAgo: 9 },
  { kind: 'instance', name: 'claude-k4m9zt08-117', parentRole: 'general-purpose', backend: 'claude', agentType: 'general-purpose', field: 'checkout', status: 'active', owner: 'platform', addedDaysAgo: 6 },
  { kind: 'instance', name: 'claude-3vn8qs45-291', parentRole: 'Explore', backend: 'claude', agentType: 'Explore', field: 'checkout', status: 'active', owner: 'platform', addedDaysAgo: 5 },
  { kind: 'instance', name: 'claude-p1w6vd52-388', parentRole: 'design-agent', backend: 'claude', agentType: 'design-agent', field: 'storefront', status: 'active', owner: 'design', addedDaysAgo: 4 },
  { kind: 'instance', name: 'claude-h2j7yr19-462', parentRole: 'claudecode', backend: 'claude', agentType: 'claudecode', field: 'infra', status: 'active', owner: 'platform', addedDaysAgo: 8 },
  { kind: 'instance', name: 'claude-w5c1kf83-330', parentRole: 'claudecode', backend: 'claude', agentType: 'claudecode', field: 'billing', status: 'active', owner: 'billing', addedDaysAgo: 7 },
  { kind: 'instance', name: 'claude-t8d4gp67-175', parentRole: 'general-purpose', backend: 'claude', agentType: 'general-purpose', field: 'billing', status: 'active', owner: 'billing', addedDaysAgo: 3 },
  { kind: 'instance', name: 'agy-3xr8cn74-051', parentRole: 'agy', backend: 'agy', agentType: 'agy', field: 'infra', status: 'active', owner: 'platform', addedDaysAgo: 3 },
  { kind: 'instance', name: 'codex-9bt5lm26-013', parentRole: 'codex', backend: 'codex', agentType: 'codex', field: 'infra', status: 'pending', owner: 'platform', addedDaysAgo: 2 },
];

const PRINCIPALS = [...USERS, ...ROLES, ...INSTANCES];

// ---------------------------------------------------------------------------------------------
// Grants
// ---------------------------------------------------------------------------------------------

/**
 * The read-only floor every active role gets.
 *
 * Written out rather than derived with `.filter(riskTier === 'read_only')`, for the reason
 * ../server/starterCatalog.js gives at length: read-only is a tier, not a promise that a tool is
 * uninteresting. Gmail's `search_threads` and Postgres's `query` both read, and both are decisions.
 * Which is why the mailbox reads are NOT in here — they are granted per role below.
 */
const READ_ONLY_BASELINE = [
  capRef('mcp_tool', 'get_me'),
  capRef('mcp_tool', 'search_repositories'),
  capRef('mcp_tool', 'get_file_contents'),
  capRef('mcp_tool', 'list_commits'),
  capRef('mcp_tool', 'list_pull_requests'),
  capRef('mcp_tool', 'get_pull_request_diff'),
  capRef('mcp_tool', 'read_text_file'),
  capRef('mcp_tool', 'read_multiple_files'),
  capRef('mcp_tool', 'list_directory'),
  capRef('mcp_tool', 'directory_tree'),
  capRef('mcp_tool', 'get_file_info'),
  capRef('mcp_tool', 'list_allowed_directories'),
  capRef('mcp_tool', 'slack_list_channels'),
  capRef('mcp_tool', 'slack_get_channel_history'),
  capRef('mcp_tool', 'slack_get_thread_replies'),
  // No skills here: skills are catalog-only and grant nothing (see the Skills section above).
];

/**
 * Grants beyond the baseline, by principal `kind:name`. A principal absent from this map holds the
 * baseline alone — which is the correct surface for `Explore` and `Plan`, the two read-only
 * subagent types.
 *
 * WHAT IS DELIBERATELY UNGRANTED, everywhere: `delete_file`, `browser_evaluate`,
 * `mark_message_spam`, `trash_file`, `notion-move-pages`, `send_message`. Six destructive rows no
 * principal holds, so the demo's catalog has a visible "registered but nobody can call it" tail —
 * which is the state a real fleet spends most of its life in, and the one a screenshot of an
 * all-green matrix would never show.
 */
const GRANTS = {
  'role:claudecode': [
    capRef('mcp_tool', 'list_workflow_runs'),
    capRef('mcp_tool', 'create_issue'), capRef('mcp_tool', 'add_issue_comment'),
    capRef('mcp_tool', 'create_pull_request'), capRef('mcp_tool', 'create_or_update_file'),
    capRef('mcp_tool', 'create_branch'),
    capRef('mcp_tool', 'write_file'), capRef('mcp_tool', 'edit_file'), capRef('mcp_tool', 'create_directory'),
    capRef('mcp_tool', 'slack_post_message'), capRef('mcp_tool', 'slack_reply_to_thread'),
    capRef('mcp_tool', 'slack_add_reaction'), capRef('mcp_tool', 'slack_get_users'),
    capRef('mcp_tool', 'list_my_issues'), capRef('mcp_tool', 'list_issue_statuses'),
    capRef('mcp_tool', 'list_teams'), capRef('mcp_tool', 'update_issue'), capRef('mcp_tool', 'create_comment'),
    capRef('mcp_tool', 'find_issues'), capRef('mcp_tool', 'get_issue_details'), capRef('mcp_tool', 'find_projects'),
    capRef('mcp_tool', 'search'), capRef('mcp_tool', 'fetch'), capRef('mcp_tool', 'notion-create-pages'),
    capRef('mcp_tool', 'notion-update-page'), capRef('mcp_tool', 'notion-create-comment'),
    capRef('mcp_tool', 'query'),
    capRef('mcp_tool', 'search_files'), capRef('mcp_tool', 'read_file_content'),
    capRef('mcp_tool', 'get_file_metadata'), capRef('mcp_tool', 'create_file'), capRef('mcp_tool', 'copy_file'),
    capRef('mcp_tool', 'search_threads'), capRef('mcp_tool', 'get_message'), capRef('mcp_tool', 'get_thread'),
    capRef('mcp_tool', 'create_draft'), capRef('mcp_tool', 'label_message'),
    capRef('mcp_tool', 'browser_snapshot'), capRef('mcp_tool', 'browser_take_screenshot'),
    capRef('mcp_tool', 'browser_navigate'), capRef('mcp_tool', 'browser_click'), capRef('mcp_tool', 'browser_type'),
    capRef('mcp_tool', 'browser_console_messages'),
    // Merge is the one destructive row the top-level orchestrator role holds, and it is on a clock —
    // see EXPIRING below, which is what puts a date on this rather than a promise.
    capRef('mcp_tool', 'merge_pull_request'),
  ],
  // `claude` is the same agent kind under its other reported name and gets the same surface minus
  // the destructive row: two `principals` rows, spelled out separately rather than aliased, so a
  // later edit that narrows one does not silently narrow the other.
  'role:claude': [
    capRef('mcp_tool', 'list_workflow_runs'),
    capRef('mcp_tool', 'create_issue'), capRef('mcp_tool', 'add_issue_comment'),
    capRef('mcp_tool', 'create_pull_request'), capRef('mcp_tool', 'create_or_update_file'),
    capRef('mcp_tool', 'create_branch'),
    capRef('mcp_tool', 'write_file'), capRef('mcp_tool', 'edit_file'), capRef('mcp_tool', 'create_directory'),
    capRef('mcp_tool', 'slack_post_message'), capRef('mcp_tool', 'slack_reply_to_thread'),
    capRef('mcp_tool', 'list_my_issues'), capRef('mcp_tool', 'update_issue'), capRef('mcp_tool', 'create_comment'),
    capRef('mcp_tool', 'find_issues'), capRef('mcp_tool', 'get_issue_details'),
    capRef('mcp_tool', 'search'), capRef('mcp_tool', 'fetch'), capRef('mcp_tool', 'notion-create-pages'),
    capRef('mcp_tool', 'query'),
    capRef('mcp_tool', 'search_files'), capRef('mcp_tool', 'read_file_content'), capRef('mcp_tool', 'create_file'),
    capRef('mcp_tool', 'search_threads'), capRef('mcp_tool', 'get_message'), capRef('mcp_tool', 'create_draft'),
    capRef('mcp_tool', 'browser_snapshot'), capRef('mcp_tool', 'browser_navigate'), capRef('mcp_tool', 'browser_click'),
  ],
  'role:general-purpose': [
    capRef('mcp_tool', 'list_workflow_runs'),
    capRef('mcp_tool', 'create_issue'), capRef('mcp_tool', 'add_issue_comment'),
    capRef('mcp_tool', 'create_pull_request'), capRef('mcp_tool', 'create_or_update_file'),
    capRef('mcp_tool', 'write_file'), capRef('mcp_tool', 'edit_file'),
    capRef('mcp_tool', 'slack_post_message'),
    capRef('mcp_tool', 'list_my_issues'), capRef('mcp_tool', 'update_issue'), capRef('mcp_tool', 'create_comment'),
    capRef('mcp_tool', 'find_issues'), capRef('mcp_tool', 'get_issue_details'), capRef('mcp_tool', 'search_events'),
    capRef('mcp_tool', 'search'), capRef('mcp_tool', 'fetch'),
    capRef('mcp_tool', 'query'),
    capRef('mcp_tool', 'search_files'), capRef('mcp_tool', 'read_file_content'),
  ],
  // Design work: Figma reads, Notion, and enough of Playwright to look at what was built. No
  // repository writes at all.
  'role:design-agent': [
    capRef('mcp_tool', 'get_code'), capRef('mcp_tool', 'get_variable_defs'),
    capRef('mcp_tool', 'get_image'), capRef('mcp_tool', 'get_code_connect_map'),
    capRef('mcp_tool', 'browser_snapshot'), capRef('mcp_tool', 'browser_take_screenshot'),
    capRef('mcp_tool', 'browser_navigate'), capRef('mcp_tool', 'browser_click'),
    capRef('mcp_tool', 'search'), capRef('mcp_tool', 'fetch'), capRef('mcp_tool', 'notion-create-pages'),
    capRef('mcp_tool', 'search_files'), capRef('mcp_tool', 'read_file_content'), capRef('mcp_tool', 'create_file'),
    capRef('mcp_tool', 'add_issue_comment'),
  ],
  // The bare-terminal / CI shape: read the repo, report, and nothing else. No Slack, no mailbox.
  'role:claude-standalone': [
    capRef('mcp_tool', 'list_workflow_runs'),
    capRef('mcp_tool', 'create_issue'), capRef('mcp_tool', 'add_issue_comment'),
    capRef('mcp_tool', 'find_issues'), capRef('mcp_tool', 'get_issue_details'),
  ],
  // The second backend, running infra work. Narrower than the Claude roles on purpose: it is the
  // newer adapter and its surface has not been widened yet.
  'role:agy': [
    capRef('mcp_tool', 'list_workflow_runs'),
    capRef('mcp_tool', 'add_issue_comment'),
    capRef('mcp_tool', 'find_issues'), capRef('mcp_tool', 'get_issue_details'),
    capRef('mcp_tool', 'find_projects'), capRef('mcp_tool', 'find_organizations'),
    capRef('mcp_tool', 'query'),
    capRef('mcp_tool', 'write_file'), capRef('mcp_tool', 'edit_file'),
  ],
  // GRANTS TO A PERSON, not to an agent — the `user` half of the model. Billing lives with Grace,
  // and the two destructive Stripe rows are hers alone: no role holds them, so an agent that wants
  // one has to go through the approvals queue rather than inherit it.
  'user:grace': [
    capRef('mcp_tool', 'list_customers'), capRef('mcp_tool', 'list_invoices'),
    capRef('mcp_tool', 'list_subscriptions'), capRef('mcp_tool', 'list_products'),
    capRef('mcp_tool', 'retrieve_balance'), capRef('mcp_tool', 'search_documentation'),
    capRef('mcp_tool', 'create_customer'), capRef('mcp_tool', 'create_payment_link'),
    capRef('mcp_tool', 'create_refund'), capRef('mcp_tool', 'cancel_subscription'),
    capRef('mcp_tool', 'create_dsn'),
  ],
  'user:ada': [
    capRef('mcp_tool', 'search_threads'), capRef('mcp_tool', 'get_message'), capRef('mcp_tool', 'get_thread'),
    capRef('mcp_tool', 'list_labels'), capRef('mcp_tool', 'create_draft'), capRef('mcp_tool', 'create_label'),
    capRef('mcp_tool', 'get_file_permissions'), capRef('mcp_tool', 'update_file'),
    capRef('mcp_tool', 'analyze_issue_with_seer'),
  ],
  'user:linus': [
    capRef('mcp_tool', 'query'), capRef('mcp_tool', 'list_workflow_runs'),
    capRef('mcp_tool', 'find_issues'), capRef('mcp_tool', 'get_issue_details'), capRef('mcp_tool', 'search_events'),
    capRef('mcp_tool', 'analyze_issue_with_seer'),
    capRef('mcp_tool', 'merge_pull_request'),
  ],
};

/**
 * Grants that carry an expiry — the ones somebody deliberately put a clock on.
 *
 * `days` is measured forward from the seed's clock, so the demo always shows a live countdown
 * rather than a set of grants that quietly all expired the week after it was provisioned. A
 * NEGATIVE value is a grant that has already lapsed, which the Grants page draws differently from
 * a revoked one and is worth having on screen: expiry and revocation are not the same event.
 */
const EXPIRING = [
  { ref: 'role:claudecode', cap: capRef('mcp_tool', 'merge_pull_request'), days: 11 },
  { ref: 'user:grace', cap: capRef('mcp_tool', 'cancel_subscription'), days: 4 },
  { ref: 'role:agy', cap: capRef('mcp_tool', 'edit_file'), days: 26 },
  { ref: 'role:general-purpose', cap: capRef('mcp_tool', 'search_events'), days: -3 },
];

/**
 * Grants that were issued and then taken back.
 *
 * They are seeded as ordinary grants and then revoked, rather than skipped, because a revoke is a
 * SOFT delete here and the surviving row is the whole point — "who held this, and who took it
 * away" is the question the Grants page's revoked rows answer. `daysAgo` backdates `revokedAt`.
 */
const REVOKED = [
  { ref: 'role:general-purpose', cap: capRef('mcp_tool', 'create_branch'), daysAgo: 23, by: 'admin', reason: 'branch sprawl — moved to claudecode only' },
  { ref: 'role:agy', cap: capRef('mcp_tool', 'slack_post_message'), daysAgo: 9, by: 'admin', reason: 'posted 40 duplicate messages to #deploys during a retry loop' },
  { ref: 'role:claude', cap: capRef('mcp_tool', 'trash_message'), daysAgo: 47, by: 'admin', reason: 'never used; withdrawn in the Q3 access review' },
  { ref: 'user:linus', cap: capRef('mcp_tool', 'share_file'), daysAgo: 31, by: 'admin', reason: 'Q3 access review — Drive sharing moved to the workspace admin console' },
];

/**
 * The approvals queue.
 *
 * `pending` rows are the demo's live question — a principal has asked for something and nobody has
 * decided yet, which is the state the Approvals page exists for. The decided rows below them are
 * the record that the queue is a log and not an inbox: a denial survives its decision.
 */
const APPROVALS = [
  { action: 'grant', ref: 'role:general-purpose', cap: capRef('mcp_tool', 'merge_pull_request'), requestedByScope: 'agent', daysAgo: 2, status: 'pending', note: 'auto-merge for dependabot PRs after CI passes' },
  { action: 'grant', ref: 'role:agy', cap: capRef('mcp_tool', 'slack_post_message'), requestedByScope: 'agent', daysAgo: 1, status: 'pending', note: 're-request after the retry loop was fixed (rate limit added)' },
  { action: 'grant', ref: 'role:codex', cap: capRef('mcp_tool', 'get_file_contents'), requestedByScope: 'node', daysAgo: 1, status: 'pending', note: 'first sighting of the codex backend on CASCADE' },
  { action: 'grant', ref: 'role:design-agent', cap: capRef('mcp_tool', 'create_or_update_file'), requestedByScope: 'agent', daysAgo: 6, status: 'denied', decidedByScope: 'admin', reason: 'design-agent opens a PR through claudecode; it does not commit directly' },
  { action: 'grant', ref: 'user:ada', cap: capRef('mcp_tool', 'analyze_issue_with_seer'), requestedByScope: 'agent', daysAgo: 14, status: 'approved', decidedByScope: 'admin', reason: 'on-call needs Seer during incident triage' },
];

/**
 * Control-plane decisions worth showing in the audit.
 *
 * Only the ones a person made. The ~180 grant rows the seeder writes are a bootstrap, not a
 * decision, and filling the audit with one entry each would bury the five entries that mean
 * something — the same reason ../server/seed-central.js writes no audit at all.
 */
const AUDIT = [
  { action: 'capability_retier', cap: capRef('mcp_tool', 'browser_evaluate'), actorScope: 'admin', daysAgo: 56, reason: 'raised mutating -> destructive: it evaluates arbitrary JS in a logged-in page' },
  { action: 'capability_retier', cap: capRef('mcp_tool', 'send_message'), actorScope: 'admin', daysAgo: 41, reason: 'raised mutating -> destructive after an agent mailed a customer list' },
  { action: 'capability_retier', cap: capRef('mcp_tool', 'share_file'), actorScope: 'admin', daysAgo: 31, reason: 'raised mutating -> destructive: sharing is an external disclosure' },
  { action: 'principal_update', ref: 'role:codex', actorScope: 'admin', daysAgo: 12, reason: 'first seen on CASCADE; left pending until the adapter is reviewed' },
  { action: 'enforcement_pause', actorScope: 'admin', daysAgo: 5, nodeId: 'demo-node-cascade', reason: 'two hooks broken after an editor upgrade — paused denials for 30 minutes while reinstalling' },
];

module.exports = {
  CAPABILITIES,
  PRINCIPALS,
  USERS,
  ROLES,
  INSTANCES,
  READ_ONLY_BASELINE,
  GRANTS,
  EXPIRING,
  REVOKED,
  APPROVALS,
  AUDIT,
  capRef,
};
