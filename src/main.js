import * as core from '@actions/core';
import * as github from '@actions/github';

/** The item types. */
const ItemType = Object.freeze({
  pr: 'pr',
  issue: 'issue'
});

/** The item states. */
// eslint-disable-next-line no-unused-vars
const ItemState = Object.freeze({
  open: 'open',
  closed: 'closed'
});

/** The octokit client. */
let client;
/** The issue or pr item. */
let item;
/** The item type. */
let itemType;
/** The action trigger payload. */
let payload;

/** The bot comment tag id. */
const messageIdMetaTag = '<!-- parse-issue-bot-meta-tag-id -->';

async function main() {
  try {
    // Get action parameters
    const githubToken = core.getInput('github-token');

    // Get client
    const context = github.context;
    payload = context.payload;
    client = github.getOctokit(githubToken, {log: 'debug'});

    // Ensure action is opened issue or PR
    if (!['opened', 'reopened', 'edited'].includes(payload.action)) {
      core.info('No issue or PR opened, reopened or edited, skipping.');
      return;
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
      return;
    }

    // Ensure sender is set
    if (!payload.sender) {
      throw new Error('No sender provided by GitHub.');
    }

    // Get event details
    item = context.issue;
    const itemBody = getItemBody(payload) || '';
    core.debug(`itemBody: ${JSON.stringify(itemBody)}`);
    core.debug(`payload: ${JSON.stringify(payload)}`);

    // If item type is issue
    if (itemType == ItemType.issue) {
      // Ensure required checkboxes
      const checkboxPatterns = [
        {regex: '- \\[x\\] I am not disclosing a vulnerability'}
      ];

      // If validation failed
      if (
        validatePattern(checkboxPatterns, itemBody).filter(v => !v.ok).length >
        0
      ) {
        // Post error comment
        const message = composeMessage({requireCheckboxes: true});
        await postComment(message);
        return;
      } else {
        core.info('All required checkboxes checked.');
      }

      // Post success comment
      const message = composeMessage();
      await postComment(message);
    }
  } catch (e) {
    core.setFailed(e.message);
    return;
  }
}

function composeMessage({requireCheckboxes} = {}) {
  // Compose terms
  const itemName = itemType == ItemType.issue ? 'issue' : 'pull request';

  // Compose message
  let message = `Thanks for opening this ${itemName}!`;
  if (requireCheckboxes) {
    message += `\n\nPlease make sure to check all required checkboxes at the top so we can look at this.`;
  }

  // Fill placeholders
  message = fillPlaceholders(message, payload);

  // Add meta tag
  message += `\n${messageIdMetaTag}`;
  return message;
}

async function findComment(text) {
  const params = {
    owner: item.owner,
    repo: item.repo,
    issue_number: item.number
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

function getItemBody(payload) {
  if (payload.issue && payload.issue.body) {
    return payload.issue.body;
  }
  if (payload.pull_request && payload.pull_request.body) {
    return payload.pull_request.body;
  }
}

// eslint-disable-next-line no-unused-vars
function getItemState(payload) {
  if (payload.issue && payload.issue.state) {
    return payload.issue.state;
  }
  if (payload.pull_request && payload.pull_request.state) {
    return payload.pull_request.state;
  }
}

async function postComment(message) {
  // Find existing bot comment
  const comment = await findComment('parse-issue-bot');
  core.debug(`comment: ${JSON.stringify(comment)}`);

  // If no bot comment exists
  if (comment) {
    // Update existing comment
    core.info(
      `Updating comment ${comment.id} in ${itemType} #${item.number} with message ${message}.`
    );
    await updateComment(comment.id, message);
  } else {
    // Post new comment
    core.info(
      `Adding new comment in ${itemType} #${item.number} with message ${message}.`
    );
    await createComment(message);
  }
}

async function createComment(message) {
  core.debug(
    `createComment: message: ${message}; itemType: ${itemType}; item: ${item}`
  );
  switch (itemType) {
    case ItemType.issue:
      await client.rest.issues.createComment({
        owner: item.owner,
        repo: item.repo,
        issue_number: item.number,
        body: message
      });
      break;

    case ItemType.pr:
      await client.rest.pulls.createReview({
        owner: item.owner,
        repo: item.repo,
        pull_number: item.number,
        body: message,
        event: 'COMMENT'
      });
      break;
  }
}

async function updateComment(id, message) {
  core.debug(
    `updateComment: id: ${id}; message: ${message}; itemType: ${itemType}; item: ${item}`
  );
  switch (itemType) {
    case ItemType.issue:
      await client.rest.issues.updateComment({
        owner: item.owner,
        repo: item.repo,
        comment_id: id,
        body: message
      });
      break;

    case ItemType.pr:
      await client.rest.pulls.updateReview({
        owner: item.owner,
        repo: item.repo,
        review_id: id,
        body: message,
        event: 'COMMENT'
      });
      break;
  }
}

// eslint-disable-next-line no-unused-vars
async function setItemState(state) {
  switch (itemType) {
    case ItemType.issue:
      await client.rest.issues.update({
        owner: item.owner,
        repo: item.repo,
        issue_number: item.number,
        state: state
      });
      break;

    case ItemType.pr:
      await client.rest.pulls.update({
        owner: item.owner,
        repo: item.repo,
        pull_number: item.number,
        state: state
      });
      break;
  }
}

function fillPlaceholders(message, params) {
  return Function(
    ...Object.keys(params),
    `return \`${message}\``
  )(...Object.values(params));
}

main();
