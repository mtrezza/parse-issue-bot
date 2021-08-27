import * as core from '@actions/core';
import * as github from '@actions/github';

/** The item types. */
const ItemType = Object.freeze({
  pr: 'pr',
  issue: 'issue',
});

/** The item sub types. */
const ItemSubType = Object.freeze({
  bug: 'bug',
  feature: 'feature',
  pr: 'pr',
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

/** The bot comment tag. */
const messageMetaTag = 'parse-issue-bot-meta-tag-id';

/** The template properties. */
const template = {
  bug: {
    headlines: [
      '#+ +New Issue Checklist',
      '#+ +Issue Description',
      '#+ +Steps to reproduce',
      '#+ +Actual Outcome',
      '#+ +Expected Outcome',
      '#+ +Environment',
    ],
    topCheckboxes: [
      '- \\[ ?[xX] ?\\] I am not disclosing',
      '- \\[ ?[xX] ?\\] I am not just asking',
      '- \\[ ?[xX] ?\\] I have searched through',
      '- \\[ ?[xX] ?\\] I can reproduce the issue',
    ],
  },
  feature: {
    headlines: [
      '#+ +New Feature / Enhancement Checklist',
      '#+ +Current Limitation',
      '#+ +Feature / Enhancement Description',
      '#+ +Example Use Case',
      '#+ +Alternatives / Workarounds',
    ],
    topCheckboxes: [
      '- \\[ ?[xX] ?\\] I am not disclosing',
      '- \\[ ?[xX] ?\\] I am not just asking',
      '- \\[ ?[xX] ?\\] I have searched through',
    ],
  },
  pr: {
    headlines: [
      '#+ +New Pull Request Checklist',
      '#+ +Issue Description',
      '#+ +Approach',
      '#+ +Example Use Case',
      '#+ +TODO',
    ],
    topCheckboxes: [
      '- \\[ ?[xX] ?\\] I am not disclosing',
      '- \\[ ?[xX] ?\\] I am creating this PR in reference',
    ],
  },
  common: {
    detailField: 'FILL_THIS_OUT',
  },
};

async function main() {
  try {
    // Get action parameters
    const githubToken = core.getInput('github-token');

    // Get client
    const context = github.context;
    client = github.getOctokit(githubToken, {log: 'debug'});
    client.rest.pulls.createReviewComment;
    // Validate event
    if (!validateEvent(context)) {
      return;
    }

    // Validate template
    if (!(await validateTemplate())) {
      return;
    }

    // Validate top checkboxes
    if (!(await validateTopCheckboxes())) {
      return;
    }

    // Validate detail fields
    if (!(await validateDetailFields())) {
      return;
    }

    // Determine item sub type
    const itemSubType = getItemSubType();
    core.debug(`main: itemSubType: ${itemSubType}`);

    // Post success comment
    const message = composeMessage({
      suggestPr: itemSubType == ItemSubType.bug,
      excitedFeature: itemSubType == ItemSubType.feature,
    });
    await postComment(message);
  } catch (e) {
    core.setFailed(e.message);
    return;
  }
}

/**
 * Validate GitHub event.
 */
function validateEvent(context) {
  // Set payload
  payload = context.payload;
  core.debug(`validateEvent: payload: ${JSON.stringify(payload)}`);

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
async function validateTemplate() {
  // Get item sub type
  const itemSubType = getItemSubType();
  core.info(`validateTemplate: itemSubType: ${itemSubType}`);

  // Compose message
  const message = composeMessage({requireTemplate: true});

  // If issue type could not be determined
  if (itemSubType === undefined) {
    // Post error comment
    await postComment(message);
    return false;
  }

  // Ensure required headlines
  const patterns = template[itemSubType].headlines.map(h => {
    return {regex: h};
  });

  // If validation failed
  if (validatePatterns(patterns, itemBody).filter(v => !v.ok).length > 0) {
    core.info('Required headlines are missing.');

    // Post error comment
    await postComment(message);
    return false;
  }

  core.info('Required headlines were found.');
  return true;
}

/**
 * Validates whether the template has all top checkboxes checked.
 */
async function validateTopCheckboxes() {
  // Get item sub type
  const issueSubType = getItemSubType();
  core.info(`validateTopCheckboxes: issueSubType: ${issueSubType}`);

  // If issue type could not be determined
  if (issueSubType === undefined) {
    // Post error comment
    await postComment(composeMessage({requireTemplate: true}));
    return false;
  }

  // Ensure required checkboxes
  const patterns = template[issueSubType].topCheckboxes.map(c => {
    return {regex: c};
  });

  // If validation failed
  if (validatePatterns(patterns, itemBody).filter(v => !v.ok).length > 0) {
    core.info('Required top checkboxes are unchecked.');

    // Post error comment
    await postComment(composeMessage({requireTopCheckboxes: true}));
    return false;
  }

  core.info('Required top checkboxes are checked.');
  return true;
}

/**
 * Validates whether the template contains unfilled detail fields.
 */
async function validateDetailFields() {
  // Create pattern
  const patterns = [{regex: template.common.detailField}];

  // If validation failed
  if (validatePatterns(patterns, itemBody).filter(v => v.ok).length > 0) {
    core.info('Required detail fields not filled out.');

    // Post error comment
    await postComment(composeMessage({requireDetailFields: true}));
    return false;
  }

  core.info('Required detail fields filled out.');
  return true;
}

/**
 * Composes a message to be posted as a comment.
 */
function composeMessage({
  requireTopCheckboxes,
  requireTemplate,
  requireDetailFields,
  suggestPr,
  excitedFeature,
} = {}) {
  // Compose terms
  const itemName = itemType == ItemType.issue ? 'issue' : 'pull request';

  // Compose message
  let message = `\n## 🤖 Parsy\n### Thanks for opening this ${itemName}!`;

  // If template is required
  if (requireTemplate) {
    message += `\n\n- ❌ Please edit your post and use the provided template when creating a new ${itemName}. This helps everyone to understand your post better and asks for essential information to quicker review the ${itemName}.`;
  }

  // If checkboxes is required
  if (requireTopCheckboxes) {
    message += `\n\n- ❌ Please check all required checkboxes at the top, otherwise your ${itemName} will be closed.`;
    message += `\n\n- ⚠️ Remember that a security vulnerability must only be reported confidentially, see our [Security Policy](https://github.com/parse-community/parse-server/blob/master/SECURITY.md). If you are not sure whether the issue is a security vulnerability, the safest way is to treat it as such and submit it confidentially to us for evaluation.`;
  }

  // If checkboxes is required
  if (requireDetailFields) {
    message += `\n\n- ❌ Please fill out all fields with a placeholder \\\`FILL_THIS_OUT\\\`, otherwise your ${itemName} will be closed. If a field does not apply to the ${itemName}, fill in \\\`n/a\\\`.`;
  }

  // If PR should be suggested
  if (suggestPr) {
    message += `\n\n- 🚀 You can help us to fix this issue faster by opening a pull request with a failing test. See our [Contribution Guide](https://github.com/parse-community/parse-server/blob/master/CONTRIBUTING.md) for how to make a pull request, or read our [New Contributor's Guide](https://blog.parseplatform.org/learn/tutorial/community/nodejs/2021/02/14/How-to-start-contributing-to-Parse-Server.html) if this is your first time contributing.`;
  }

  if (excitedFeature) {
    message += `\n\n- 🎉 We are excited about your ideas for improvement!`;
  }

  // Add beta note
  message += `\n\n*I'm in beta, so forgive me if I'm still making mistakes.*`;

  // Fill placeholders
  message = fillPlaceholders(message, payload);

  // Add meta tag
  message += createMessageMetaTag({
    requireTemplate,
    requireTopCheckboxes,
    requireDetailFields,
    suggestPr,
    excitedFeature,
  });

  core.debug(`composeMessage: message: ${message}`);
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
function validatePatterns(patterns, text) {
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
 * Determines the item sub type.
 */
function getItemSubType() {
  return new RegExp(`^${template.bug.headlines[0]}`).test(itemBody)
    ? ItemSubType.bug
    : new RegExp(`^${template.feature.headlines[0]}`).test(itemBody)
      ? ItemSubType.feature
      : new RegExp(`^${template.pr.headlines[0]}`).test(itemBody)
        ? ItemSubType.pr
        : undefined;
}

/**
 * Posts a comment.
 * @param {string} message The message to post.
 */
async function postComment(message) {
  // Find existing bot comment
  const comment = await findComment(messageMetaTag);
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
    case ItemType.pr:
      await client.rest.issues.createComment({
        owner: item.owner,
        repo: item.repo,
        issue_number: item.number,
        body: message,
      });
      break;

    // case ItemType.pr:
    //   await client.rest.pulls.createReview({
    //     owner: item.owner,
    //     repo: item.repo,
    //     pull_number: item.number,
    //     body: message,
    //     event: 'COMMENT',
    //   });
    //   break;
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

/**
 * Creates a meta data tag.
 */
function createMessageMetaTag(data) {
  return `\n\n<!-- ${messageMetaTag} ${JSON.stringify(data)} -->\n\n`;
}

main();
