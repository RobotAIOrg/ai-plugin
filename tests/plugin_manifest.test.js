const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const manifest = JSON.parse(fs.readFileSync(
  path.resolve(__dirname, '../.codex-plugin/plugin.json'),
  'utf8',
));
const claudeManifest = JSON.parse(fs.readFileSync(
  path.resolve(__dirname, '../.claude-plugin/plugin.json'),
  'utf8',
));
const marketplaceSubmission = JSON.parse(fs.readFileSync(
  path.resolve(__dirname, '../chatgpt-app-submission.json'),
  'utf8',
));
const mcpConfiguration = JSON.parse(fs.readFileSync(
  path.resolve(__dirname, '../.mcp.json'),
  'utf8',
));

test('uses the supported Codex plugin manifest contract', () => {
  assert.deepEqual(Object.keys(manifest).sort(), [
    'author',
    'homepage',
    'interface',
    'keywords',
    'license',
    'mcpServers',
    'name',
    'skills',
    'version',
    'description',
  ].sort());
  assert.equal(typeof manifest.author, 'object');
  assert.deepEqual(manifest.interface, {
    displayName: 'i118 Phone Assistant',
    shortDescription: 'View i118.ai phone orders.',
    longDescription: 'View i118.ai phone orders, customer requests, and order details.',
    developerName: 'i118.ai',
    category: 'Productivity',
    capabilities: ['Read'],
    websiteURL: 'https://i118.ai',
    privacyPolicyURL: 'https://docs.i118.ai/en/privacy-policy',
    termsOfServiceURL: 'https://docs.i118.ai/en/terms-of-service',
    defaultPrompt: [
      'Show my newest phone orders.',
      'Check my i118 Phone Assistant connection.',
      'Review all new i118 Phone Assistant orders and summarize the next steps.',
    ],
    brandColor: '#4F46E5',
    composerIcon: './assets/i118-logo-square.png',
    logo: './assets/i118-logo-square.png',
  });
  assert.doesNotMatch(manifest.description, /manage|automate|configuration|settings/i);
  assert.doesNotMatch(claudeManifest.description, /manage|automate|configuration|settings/i);
  for (const assetPath of [manifest.interface.composerIcon, manifest.interface.logo]) {
    assert.ok(fs.statSync(path.resolve(__dirname, '..', assetPath)).isFile());
  }
  assert.equal(manifest.homepage, 'https://i118.ai');
  assert.equal(claudeManifest.homepage, 'https://i118.ai');
  assert.equal(claudeManifest.metadata.documentationUrl, 'https://i118.ai');
  assert.equal(claudeManifest.version, '1.0.0');
  assert.equal(manifest.version, '1.0.0');
  assert.equal(manifest.mcpServers.i118.url, 'https://mcp.i118.ai/mcp');
  assert.equal(mcpConfiguration.mcpServers.i118.url, manifest.mcpServers.i118.url);
});

test('publishes all plugin skills, agent guidance, and read-only tool annotations', () => {
  const skillDirectories = fs.readdirSync(path.resolve(__dirname, '../skills'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  assert.deepEqual(skillDirectories, ['i118-order-routine', 'i118-orders', 'i118-setup']);
  for (const skillDirectory of skillDirectories) {
    const skill = fs.readFileSync(
      path.resolve(__dirname, '..', 'skills', skillDirectory, 'SKILL.md'),
      'utf8',
    );
    assert.match(skill, /^---\nname: /);
    assert.match(skill, /compatibility:/);
  }

  for (const skillDirectory of ['i118-orders', 'i118-order-routine']) {
    assert.ok(fs.statSync(
      path.resolve(__dirname, '..', 'skills', skillDirectory, 'references', 'reference.md'),
    ).isFile());
    assert.doesNotMatch(
      fs.readFileSync(path.resolve(__dirname, '..', 'skills', skillDirectory, 'SKILL.md'), 'utf8'),
      /\]\(reference\.md\)/,
    );
  }

  const orderAgent = fs.readFileSync(
    path.resolve(__dirname, '../agents/i118-order-processor.md'),
    'utf8',
  );
  assert.match(orderAgent, /^---\nname: i118-order-processor/m);
  assert.match(orderAgent, /model: sonnet/);
  assert.match(orderAgent, /I118_STATE_NAMESPACE=orders/);

  assert.deepEqual(Object.keys(marketplaceSubmission.tools).sort(), [
    'get_order',
    'get_orders',
    'get_suborganization',
    'get_suborganizations',
    'whoami',
  ]);
  for (const tool of Object.values(marketplaceSubmission.tools)) {
    assert.deepEqual(tool.annotations, {
      readOnlyHint: true,
      openWorldHint: false,
      destructiveHint: false,
    });
    assert.match(tool.justifications.read_only_justification, /read|lookup|list/i);
    assert.match(tool.justifications.destructive_justification, /no|nothing|unchanged|read-only/i);
  }
});

test('published ChatGPT documentation does not direct users to Developer Mode', () => {
  for (const relativePath of ['README.md', 'skills/i118-setup/SKILL.md']) {
    const documentation = fs.readFileSync(path.resolve(__dirname, '..', relativePath), 'utf8');
    assert.doesNotMatch(documentation, /ChatGPT Developer Mode/i);
    assert.match(documentation, /ChatGPT app directory/i);
  }
});

test('documents namespaced token-owned renewable order routines', () => {
  const routineSkill = fs.readFileSync(
    path.resolve(__dirname, '../skills/i118-order-routine/SKILL.md'),
    'utf8',
  );
  const routineReference = fs.readFileSync(
    path.resolve(__dirname, '../skills/i118-order-routine/references/reference.md'),
    'utf8',
  );
  const orderAgent = fs.readFileSync(
    path.resolve(__dirname, '../agents/i118-order-processor.md'),
    'utf8',
  );
  const readme = fs.readFileSync(path.resolve(__dirname, '../README.md'), 'utf8');

  for (const documentation of [routineSkill, routineReference, orderAgent, readme]) {
    assert.match(documentation, /I118_STATE_NAMESPACE/);
  }
  for (const documentation of [routineSkill, routineReference, orderAgent]) {
    assert.match(documentation, /claim token/i);
    assert.match(documentation, /renew/i);
  }
  assert.match(routineSkill, /reset.*generation boundary/is);
  assert.match(routineReference, /organizationResetTokens/);
  assert.match(routineReference, /crashes after appending the reset/i);
});

test('keeps marketplace test cases self-contained and aligned with published tools', () => {
  assert.equal(marketplaceSubmission.test_cases.length, 5);
  assert.equal(marketplaceSubmission.negative_test_cases.length, 3);
  const cases = [
    ...marketplaceSubmission.test_cases,
    ...marketplaceSubmission.negative_test_cases,
  ];
  const publishedTools = new Set(Object.keys(marketplaceSubmission.tools));

  for (const testCase of cases) {
    assert.equal(typeof testCase.description, 'string');
    assert.equal(typeof testCase.user_prompt, 'string');
    assert.equal(typeof testCase.expected_output, 'string');
    assert.doesNotMatch(testCase.user_prompt, /\b(?:this|that) (?:list|store|query)\b/i);
    for (const toolName of (testCase.tools_triggered || '').split(',').map((name) => name.trim()).filter(Boolean)) {
      assert.equal(publishedTools.has(toolName), true, `Unknown marketplace test tool: ${toolName}`);
    }
  }

  const organizationChoiceCase = marketplaceSubmission.test_cases.find((entry) => (
    entry.description.includes('explicit organization choice')
  ));
  assert.equal(organizationChoiceCase.tools_triggered, 'get_suborganizations');
  assert.match(organizationChoiceCase.expected_output, /does not fetch orders/i);

  const cursorCase = marketplaceSubmission.negative_test_cases.find((entry) => (
    entry.description.includes('cursor reused')
  ));
  assert.match(cursorCase.user_prompt, /page size 1/i);
  assert.match(cursorCase.user_prompt, /changing only the sort/i);

  const mutationCase = marketplaceSubmission.negative_test_cases.find((entry) => (
    entry.description.includes('order mutations')
  ));
  assert.equal(mutationCase.tools_triggered, null);
  assert.match(mutationCase.expected_output, /read-only/i);

  const coveredTools = new Set(cases.flatMap((testCase) => (
    (testCase.tools_triggered || '').split(',').map((name) => name.trim()).filter(Boolean)
  )));
  assert.deepEqual(coveredTools, publishedTools);

  const directOrderCase = marketplaceSubmission.test_cases.find((entry) => (
    entry.description.includes('direct order lookup and continued order retrieval')
  ));
  assert.match(directOrderCase.user_prompt, /retain its ID privately/i);
  assert.equal(directOrderCase.tools_triggered, 'get_suborganizations, get_orders, get_order');

  assert.match(directOrderCase.user_prompt, /includeTotalCount enabled/);
  assert.match(directOrderCase.user_prompt, /continuation cursor/i);
});

test('documents read-only mutation refusal and time-zone limitations', () => {
  const orderSkill = fs.readFileSync(
    path.resolve(__dirname, '../skills/i118-orders/SKILL.md'),
    'utf8',
  );
  const readme = fs.readFileSync(path.resolve(__dirname, '../README.md'), 'utf8');
  const agents = fs.readFileSync(path.resolve(__dirname, '../AGENTS.md'), 'utf8');

  assert.match(orderSkill, /strictly read-only/i);
  assert.match(orderSkill, /do not ask for organization, order,/i);
  assert.match(orderSkill, /generic not-found/i);
  for (const documentation of [orderSkill, readme, agents]) {
    assert.match(documentation, /(?:does not expose.*time zone|no time zone|cannot be resolved)/i);
    assert.match(documentation, /(?:without asking|automatically|do not assume|never guess)/i);
  }
});

test('requires organization choice before generic multi-organization order queries', () => {
  const orderSkill = fs.readFileSync(
    path.resolve(__dirname, '../skills/i118-orders/SKILL.md'),
    'utf8',
  );

  assert.match(orderSkill, /more than one.*organization[\s\S]*ask the user/i);
  assert.match(orderSkill, /explicitly named one/i);
  assert.match(orderSkill, /asks for orders across all organizations/i);
  assert.match(orderSkill, /do not silently choose the first/i);
});

test('uses the chat user time zone without inventing an organization setting', () => {
  const orderSkill = fs.readFileSync(
    path.resolve(__dirname, '../skills/i118-orders/SKILL.md'),
    'utf8',
  );

  assert.match(orderSkill, /MCP does not expose an organization time zone/i);
  assert.match(orderSkill, /chat user's local.*time zone/i);
  assert.match(orderSkill, /without asking the user/i);
  assert.match(orderSkill, /createdAt.*chat user's local/i);
  assert.match(orderSkill, /MUST.*both.*local date.*time.*time zone/is);
  assert.match(orderSkill, /never display.*raw UTC.*unless.*explicitly asks/is);
  assert.match(orderSkill, /customerTimezone.*appointment-specific/i);
  assert.doesNotMatch(orderSkill, /including its `timeZoneId`/i);
  assert.match(orderSkill, /no more matching orders/i);
  assert.match(orderSkill, /do not say.*pages.*customer/i);
});

test('records local and live Claude Code and Codex validation without secrets', () => {
  const testing = fs.readFileSync(path.resolve(__dirname, '../TESTING.md'), 'utf8');

  assert.match(testing, /actual Claude Code and Codex CLIs/i);
  assert.match(testing, /45 Node tests/i);
  assert.match(testing, /Live Claude Code matrix/i);
  assert.match(testing, /Live Codex matrix/i);
  assert.match(testing, /exactly\s+five positive cases and three negative cases/i);
  assert.match(testing, /Complete `get_orders` reuse/i);
  assert.match(testing, /Fresh substring search/i);
  assert.match(testing, /\.test_cases\[\]\.user_prompt, \.negative_test_cases\[\]\.user_prompt/);
  assert.match(testing, /claude -p[\s\S]+"\$prompt"/);
  assert.match(testing, /codex exec[\s\S]+"\$prompt"/);
  assert.match(testing, /fresh, non-persistent CLI process for each marketplace prompt/i);
  assert.match(testing, /Do not retain raw CLI traces in the repository/i);
  assert.equal((testing.match(/10\/10 PASS/g) || []).length, 2);
  assert.match(testing, /mcp_oauth_callback_port=1455/);
  assert.match(testing, /--scopes openid,profile,email,offline_access/);
  assert.doesNotMatch(testing, /client_id\s*[:=]\s*\S+/i);
  assert.doesNotMatch(testing, /client_secret\s*[:=]/i);
});
