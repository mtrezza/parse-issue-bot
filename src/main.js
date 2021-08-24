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
      '### Environment'
    ]
  },
  feature: {
    headlines: [
      '### New Feature / Enhancement Checklist',
      '### Current Limitation',
      '### Feature / Enhancement Description',
      '### Example Use Case',
      '### Alternatives / Workarounds'
    ]
  },
  common: {
    placeholder: 'FILL_THIS_OUT'
  }
};

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
    itemBody = getItemBody(payload) || '';
    core.debug(`itemBody: ${JSON.stringify(itemBody)}`);
    core.debug(`payload: ${JSON.stringify(payload)}`);

    // If item type is issue
    if (itemType == ItemType.issue) {
      if (!(await validateIssueTemplate())) {
        return;
      }
      if (!(await validateIssueCheckboxes())) {
        return;
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

async function validateIssueTemplate() {
  // Determine issue type
  const IssueType = {
    bug: 'bug',
    feature: 'feature'
  };
  const issueType = itemBody.includes(template.bug.headlines[0])
    ? IssueType.bug
    : itemBody.includes(template.feature.headlines[0])
      ? IssueType.feature
      : undefined;
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

async function validateIssueCheckboxes() {
  // Ensure required checkboxes
  const patterns = [{regex: '- \\[x\\] I am not disclosing a vulnerability'}];

  // Compose message
  const message = composeMessage({requireCheckboxes: true});

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

function composeMessage({requireCheckboxes, requireTemplate} = {}) {
  // Compose terms
  const itemName = itemType == ItemType.issue ? 'issue' : 'pull request';

  // Compose message
  let message = `🤖 Thanks for opening this ${itemName}!`;
  if (requireTemplate) {
    message += `\n\nPlease edit your post and use provided template when creating a new issue. This helps us to understand the issue better and evaluate.  `;
  }
  if (requireCheckboxes) {
    message += `\n\nPlease make sure to check all required checkboxes at the top, otherwise this issue will be closed.`;
    message += `\n\n⚠️ Remember that security vulnerabilities must only be reported confidentially, see our [Security Policy](https://github.com/parse-community/parse-server/blob/master/SECURITY.md). If you are not sure whether the issue is a security vulnerability, the safest way is to treat it as such until we have evaluated it.`;
  }

  if (!requireCheckboxes && !requireTemplate) {
    message += `\n\nIf you can .`;
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
      `Updating comment ${comment.id} in ${itemType} #${item.number} with message:\n\n${message}`
    );
    await updateComment(comment.id, message);
  } else {
    // Post new comment
    core.info(`Adding new comment in ${itemType} #${item.number} with message:\n\n${message}`);
    await createComment(message);
  }
}

async function createComment(message) {
  core.debug(`createComment: message: ${message}; itemType: ${itemType}; item: ${item}`);
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
  core.debug(`updateComment: id: ${id}; message: ${message}; itemType: ${itemType}; item: ${item}`);
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
  return Function(...Object.keys(params), `return \`${message}\``)(...Object.values(params));
}

main();
