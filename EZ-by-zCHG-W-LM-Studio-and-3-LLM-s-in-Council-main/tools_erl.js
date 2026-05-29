// ERL v3 Tool Functions for MCP Server
// These provide ERL operations as MCP tools for the agent

import { erlHistory, erlSearch, erlMerge, erlVerify, getLedger, erlAppend, erlBranch } from './server.js';

// Tool: erl_history — Get branch history
export async function tool_erl_history(args = {}) {
  const ledger = getLedger();
  const branch = args.branch || "main";
  const limit = args.limit || 20;
  
  const history = erlHistory(ledger, { branch, limit });
  
  return {
    branch,
    count: history.length,
    entries: history.map(e => ({
      id: e.id.substring(0, 16) + "...",
      timestamp: e.timestamp.split('T')[1].split('.')[0],
      role: e.role,
      branch: e.branch,
      tags: e.tags.join(", "),
      content: e.content.length > 200 ? e.content.substring(0, 200) + "..." : e.content
    }))
  };
}

// Tool: erl_search — Search ledger entries
export async function tool_erl_search(args = {}) {
  const ledger = getLedger();
  const query = args.query;
  const branch = args.branch || null;
  const role = args.role || null;
  const tags = args.tags || [];
  const limit = args.limit || 20;
  
  const results = erlSearch(ledger, { query, branch, role, tags, limit });
  
  return {
    query,
    count: results.length,
    results: results.map(e => ({
      id: e.id.substring(0, 16) + "...",
      timestamp: e.timestamp,
      branch: e.branch,
      role: e.role,
      tags: e.tags.join(", "),
      content: e.content
    }))
  };
}

// Tool: erl_verify — Verify ledger integrity
export async function tool_erl_verify(args = {}) {
  const ledger = getLedger();
  const branch = args.branch || "main";
  
  const verification = erlVerify(ledger, branch);
  
  return {
    branch,
    valid: verification.valid,
    length: verification.length,
    errors: verification.errors.length,
    errors: verification.errors
  };
}

// Tool: erl_merge — Merge one branch into another
export async function tool_erl_merge(args = {}) {
  const ledger = getLedger();
  const fromBranch = args.from_branch;
  const intoBranch = args.into_branch || "main";
  
  if (!fromBranch) {
    throw new Error("from_branch is required");
  }
  
  const result = erlMerge(ledger, { from_branch: fromBranch, into_branch: intoBranch });
  
  return {
    from: fromBranch,
    into: intoBranch,
    merged_count: result.merged_count,
    ids: result.ids.map(id => id.substring(0, 16) + "...")
  };
}

// Tool: erl_create_branch — Create a new branch
export async function tool_erl_create_branch(args = {}) {
  const ledger = getLedger();
  const name = args.name;
  const fromBranch = args.from_branch || "main";
  
  if (!name) {
    throw new Error("branch name is required");
  }
  
  if (ledger.branches[name] !== undefined) {
    throw new Error(`branch '${name}' already exists`);
  }
  
  const result = erlBranch(ledger, { name, from_branch: fromBranch });
  
  return {
    branch: name,
    diverged_from: result.diverged_from ? result.diverged_from.substring(0, 16) + "..." : null,
    message: `Created branch '${name}' diverging from '${fromBranch}'`
  };
}

// Tool: erl_append — Add an entry to a branch
export async function tool_erl_append(args = {}) {
  const ledger = getLedger();
  const branch = args.branch || "main";
  const role = args.role || "thought";
  const content = args.content;
  const tags = args.tags || [];
  
  if (!content) {
    throw new Error("content is required");
  }
  
  const entry = erlAppend(ledger, { branch, role, content, tags });
  
  return {
    id: entry.id.substring(0, 16) + "...",
    branch,
    role,
    timestamp: entry.timestamp.split('T')[1].split('.')[0],
    message: `Added entry to '${branch}' branch`
  };
}

export default {
  tool_erl_history,
  tool_erl_search,
  tool_erl_verify,
  tool_erl_merge,
  tool_erl_create_branch,
  tool_erl_append
};
