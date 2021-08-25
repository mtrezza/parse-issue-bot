import * as core from '@actions/core';
import * as github from '@actions/github';

/** The item types. */
const ItemType = Object.freeze({
  pr: 'pr',
  issue: 'issue',
});

/** The item issue types. */
const ItemIssueType = Object.freeze({
  bug: 'bug',
  feature: 'feature',
});

/** The item states. */
// eslint-disable-next-line no-unused-vars
const ItemState = Object.freeze({
  open: 'open',
  closed: 'closed',
});

/** The octokit client. */
let client;
/** The issue or pr item. */
let item;
/** The item type. */
let itemType;
/** The item body. */
let itemBody;
/** The action trigger payload. */
let payload;

/** The bot comment tag id. */
const messageIdMetaTag = '<!-- parse-issue-bot-meta-tag-id -->';

/** The template properties. */
const template = {
  bug: {
    headlines: [
      '### New Issue Checklist',
      '### Issue Description',
      '### Steps to reproduce',
      '### Actual Outcome',
      '### Expected Outcome',
      '### Environment',
    ],
    checkboxes: [
      '- \\[ ?[xX] ?\\] I am not disclosing a',
      '- \\[ ?[xX] ?\\] I am not just asking a',
      '- \\[ ?[xX] ?\\] I have searched through',
      '- \\[ ?[xX] ?\\] I can reproduce the issue',
    ],
  },
  feature: {
    headlines: [
      '### New Feature / Enhancement Checklist',
      '### Current Limitation',
      '### Feature / Enhancement Description',
      '### Example Use Case',
      '### Alternatives / Workarounds',
    ],
    checkboxes: [
      '- \\[ ?[xX] ?\\] I am not disclosing a',
      '- \\[ ?[xX] ?\\] I am not just asking a',
      '- \\[ ?[xX] ?\\] I have searched through',
    ],
  },
  common: {
    placeholder: 'FILL_THIS_OUT',
  },
};

async function main() {
  try {
    // Get action parameters
    const githubToken = core.getInput('github-token');

    // Get client
    const context = github.context;
    client = github.getOctokit(githubToken, {log: 'debug'});

    // Validate event
    if (!validateEvent(context)) {
      return;
    }

    // If item type is issue
    if (itemType == ItemType.issue) {
      if (!(await validateIssueTemplate())) {
        return;
      }
      if (!(await validateIssueCheckboxes())) {
        return;
      }

      // Determine item issue type
      const itemIssueType = getItemIssueType();
      core.debug(`main: itemIssueType: ${itemIssueType}`);

      // Post success comment
      const message = composeMessage({
        suggestPr: itemIssueType == ItemIssueType.bug,
        excitedFeature: itemIssueType == ItemIssueType.feature,
      });
      await postComment(message);
    }
  } catch (e) {
    core.setFailed(e.message);
    return;
  }
}

function validateEvent(context) {
  // Set payload
  payload = context.payload;

  // Ensure action is opened issue or PR
  if (!['opened', 'reopened', 'edited'].includes(payload.action)) {
    core.info('No issue or PR opened, reopened or edited, skipping.');
    return false;
  }

  // Determine item type
  itemType =
    payload.issue !== undefined
      ? ItemType.issue
      : payload.pull_request !== undefined
        ? ItemType.pr
        : undefined;

  // If action was not invoked due to issue or PR
  if (itemType === undefined) {
    core.info('Not a pull request or issue, skipping.');
    return false;
  }

  // Ensure sender is set
  if (!payload.sender) {
    throw new Error('No sender provided by GitHub.');
  }

  // Set event details
  item = context.issue;
  itemBody = getItemBody(payload) || '';
  core.debug(`itemBody: ${JSON.stringify(itemBody)}`);
  core.debug(`payload: ${JSON.stringify(payload)}`);
  return true;
}

/**
 * Validates whether the template contains all required headlines.
 */
async function validateIssueTemplate() {
  const issueType = getItemIssueType();
  core.info(`validateIssueTemplate: issueType: ${issueType}`);

  // Compose message
  const message = composeMessage({requireTemplate: true});

  // If issue type could not be determined
  if (issueType === undefined) {
    // Post error comment
    await postComment(message);
    return false;
  }

  // Ensure required headlines
  const patterns = template[issueType].headlines.map(h => {
    return {regex: h};
  });

  // If validation failed
  if (validatePattern(patterns, itemBody).filter(v => !v.ok).length > 0) {
    core.info('Required headlines are missing.');

    // Post error comment
    await postComment(message);
    return false;
  }

  core.info('Required headlines were found.');
  return true;
}

/**
 * Validates whether the template has all required checkboxes checked.
 */
async function validateIssueCheckboxes() {
  const issueType = getItemIssueType();
  core.info(`validateIssueCheckboxes: issueType: ${issueType}`);

  // If issue type could not be determined
  if (issueType === undefined) {
    // Post error comment
    await postComment(composeMessage({requireTemplate: true}));
    return false;
  }

  // Compose message
  const message = composeMessage({requireCheckboxes: true});

  // Ensure required checkboxes
  const patterns = template[issueType].checkboxes.map(c => {
    return {regex: c};
  });

  // If validation failed
  if (validatePattern(patterns, itemBody).filter(v => !v.ok).length > 0) {
    core.info('Required checkboxes are unchecked.');

    // Post error comment
    await postComment(message);
    return false;
  }

  core.info('Required checkboxes are checked.');
  return true;
}

/**
 * Composes a message to be posted as a comment.
 */
function composeMessage({requireCheckboxes, requireTemplate, suggestPr, excitedFeature} = {}) {
  // Compose terms
  const itemName = itemType == ItemType.issue ? 'issue' : 'pull request';

  // Compose message
  let message = `${messageIdMetaTag}`;
  message += `\n## 🤖 Parsy\n### Thanks for opening this ${itemName}!`;

  // If template is required
  if (requireTemplate) {
    message += `\n\n- ❌ Please edit your post and use the provided template when creating a new issue. This helps everyone to understand the issue better and asks for essential information to quicker investigate the issue.`;
  }

  // If checkboxes is required
  if (requireCheckboxes) {
    message += `\n\n- ❌ Please make sure to check all required checkboxes at the top, otherwise your issue will be closed.`;
    message += `\n\n- ⚠️ Remember that security vulnerability must only be reported confidentially, see our [Security Policy](https://github.com/parse-community/parse-server/blob/master/SECURITY.md). If you are not sure whether the issue is a security vulnerability, the safest way is to treat it as such and submit it confidentially to us for evaluation.`;
  }

  // If PR should be suggested
  if (suggestPr) {
    message += `\n\n- 🚀 You can help us to fix this issue faster by opening a Pull Request with a failing test. See our [Contribution Guide](https://github.com/parse-community/parse-server/blob/master/CONTRIBUTING.md) for how to make a Pull Request, or read our [New Contributor's Guide](https://blog.parseplatform.org/learn/tutorial/community/nodejs/2021/02/14/How-to-start-contributing-to-Parse-Server.html) if this is your first time contributing. In any case, feel free to ask if you have any questions.`;
  }

  if (excitedFeature) {
    message += `\n\n- 🎉 We are excited about your ideas for improvement!`;
  }

  // Add beta note
  message += `\n\n*I'm in beta, so forgive me if I'm still making mistakes.*`;

  // Fill placeholders
  message = fillPlaceholders(message, payload);
  return message;
}

/**
 * Finds a comment in the current issue.
 * @param {string} text The text in the comment to find.
 */
async function findComment(text) {
  const params = {
    owner: item.owner,
    repo: item.repo,
    issue_number: item.number,
  };

  for await (const {data: comments} of client.paginate.iterator(
    client.rest.issues.listComments,
    params
  )) {
    const comment = comments.find(comment => comment.body.includes(text));
    if (comment) return comment;
  }

  return undefined;
}

/**
 * Validates a text against regex patterns.
 */
function validatePattern(patterns, text) {
  const validations = [];
  for (const pattern of patterns) {
    const regex = new RegExp(pattern.regex);

    const validation = Object.assign({}, pattern);
    validation.ok = regex.test(text);
    validations.push(validation);
  }

  core.debug(`validations: ${JSON.stringify(validations)}`);
  return validations;
}

/**
 * Returns the item body text.
 */
function getItemBody(payload) {
  if (payload.issue && payload.issue.body) {
    return payload.issue.body;
  }
  if (payload.pull_request && payload.pull_request.body) {
    return payload.pull_request.body;
  }
}

/**
 * Determines whether an issue item is a feature request or a bug report.
 */
function getItemIssueType() {
  return itemBody.includes(template.bug.headlines[0])
    ? ItemIssueType.bug
    : itemBody.includes(template.feature.headlines[0])
      ? ItemIssueType.feature
      : undefined;
}

/**
 * Posts a comment.
 * @param {string} message The message to post.
 */
async function postComment(message) {
  // Find existing bot comment
  const comment = await findComment('parse-issue-bot');
  core.debug(`comment: ${JSON.stringify(comment)}`);

  // If no bot comment exists
  if (comment) {
    // Update existing comment
    core.info(
      `Updating comment ${comment.id} in ${itemType} #${item.number} with message:\n\n${message}`
    );
    await updateComment(comment.id, message);
  } else {
    // Post new comment
    core.info(`Adding new comment in ${itemType} #${item.number} with message:\n\n${message}`);
    await createComment(message);
  }
}

/**
 * Creates a new comment.
 * @param {string} message The message to post.
 */
async function createComment(message) {
  core.debug(`createComment: message: ${message}; itemType: ${itemType}; item: ${item}`);
  switch (itemType) {
    case ItemType.issue:
      await client.rest.issues.createComment({
        owner: item.owner,
        repo: item.repo,
        issue_number: item.number,
        body: message,
      });
      break;

    case ItemType.pr:
      await client.rest.pulls.createReview({
        owner: item.owner,
        repo: item.repo,
        pull_number: item.number,
        body: message,
        event: 'COMMENT',
      });
      break;
  }
}

/**
 * Updates an existing comment.
 * @param {string} message The message to post.
 */
async function updateComment(id, message) {
  core.debug(`updateComment: id: ${id}; message: ${message}; itemType: ${itemType}; item: ${item}`);
  switch (itemType) {
    case ItemType.issue:
      await client.rest.issues.updateComment({
        owner: item.owner,
        repo: item.repo,
        comment_id: id,
        body: message,
      });
      break;

    case ItemType.pr:
      await client.rest.pulls.updateReview({
        owner: item.owner,
        repo: item.repo,
        review_id: id,
        body: message,
        event: 'COMMENT',
      });
      break;
  }
}

/**
 * Returns the item state.
 */
// eslint-disable-next-line no-unused-vars
function getItemState(payload) {
  if (payload.issue && payload.issue.state) {
    return payload.issue.state;
  }
  if (payload.pull_request && payload.pull_request.state) {
    return payload.pull_request.state;
  }
}

/**
 * Sets the item state.
 */
// eslint-disable-next-line no-unused-vars
async function setItemState(state) {
  switch (itemType) {
    case ItemType.issue:
      await client.rest.issues.update({
        owner: item.owner,
        repo: item.repo,
        issue_number: item.number,
        state: state,
      });
      break;

    case ItemType.pr:
      await client.rest.pulls.update({
        owner: item.owner,
        repo: item.repo,
        pull_number: item.number,
        state: state,
      });
      break;
  }
}

/**
 * Fills the placeholders in the message.
 */
function fillPlaceholders(message, params) {
  return Function(...Object.keys(params), `return \`${message}\``)(...Object.values(params));
}

main();
