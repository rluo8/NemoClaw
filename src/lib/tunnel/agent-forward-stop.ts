// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";

import { resolveOpenshell } from "../adapters/openshell/resolve";
import * as agentRuntime from "../agent/runtime";
import {
  bestEffortForwardStopForSandbox,
  type ForwardListRunner,
  type ForwardStopRunner,
} from "../onboard/forward-cleanup";
import * as registry from "../state/registry";

type Reporter = (message: string) => void;

type AgentWithForwards = {
  displayName?: string;
  forward_ports?: unknown;
};

type SandboxWithDashboardPort = {
  dashboardPort?: unknown;
};

type StopAgentForwardPortsDeps = {
  getSessionAgent?: (sandboxName?: string) => AgentWithForwards | null;
  getAgentDisplayName?: (agent: AgentWithForwards | null) => string;
  getSandbox?: (sandboxName: string) => SandboxWithDashboardPort | null;
  resolveOpenshell?: () => string | null;
  runOpenshell?: ForwardStopRunner;
  runCaptureOpenshell?: ForwardListRunner;
  info?: Reporter;
  warn?: Reporter;
};

function getAgentForwardPorts(agent: AgentWithForwards, dashboardPort: unknown): number[] {
  const ports = new Set<number>();
  const candidates = [
    ...(Array.isArray(agent.forward_ports) ? agent.forward_ports : []),
    dashboardPort,
  ];
  for (const rawPort of candidates) {
    const port =
      typeof rawPort === "number"
        ? rawPort
        : typeof rawPort === "string" && /^\d+$/.test(rawPort.trim())
          ? Number(rawPort.trim())
          : NaN;
    if (Number.isInteger(port) && port >= 1024 && port <= 65535) {
      ports.add(port);
    }
  }
  return [...ports];
}

function makeRunOpenshell(openshell: string): ForwardStopRunner {
  return (args, opts) => {
    const result = spawnSync(openshell, args, {
      encoding: "utf-8",
      stdio: opts.suppressOutput ? "ignore" : "inherit",
    });
    if (!opts.ignoreError && result.status !== 0) {
      throw new Error(`openshell ${args.join(" ")} failed`);
    }
    return result;
  };
}

function makeRunCaptureOpenshell(openshell: string): ForwardListRunner {
  return (args, opts) => {
    const result = spawnSync(openshell, args, {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: opts.timeout,
    });
    if (result.status !== 0) {
      throw new Error(`openshell ${args.join(" ")} failed`);
    }
    return result.stdout || "";
  };
}

export function stopAgentForwardPortsForStop(
  sandboxName: string | undefined,
  deps: StopAgentForwardPortsDeps = {},
): void {
  if (!sandboxName) return;

  const getSessionAgent = deps.getSessionAgent ?? agentRuntime.getSessionAgent;
  const agent = getSessionAgent(sandboxName);
  if (!agent) return;

  const getSandbox = deps.getSandbox ?? registry.getSandbox;
  const ports = getAgentForwardPorts(agent, getSandbox(sandboxName)?.dashboardPort);
  if (ports.length === 0) return;

  const displayName = deps.getAgentDisplayName
    ? deps.getAgentDisplayName(agent)
    : agentRuntime.getAgentDisplayName(
        agent as Parameters<typeof agentRuntime.getAgentDisplayName>[0],
      );
  const warn = deps.warn ?? (() => {});
  const info = deps.info ?? (() => {});

  const openshell = (deps.resolveOpenshell ?? resolveOpenshell)();
  if (!openshell) {
    warn(`openshell not found - cannot stop ${displayName} host port forwards.`);
    return;
  }

  const runOpenshell = deps.runOpenshell ?? makeRunOpenshell(openshell);
  const runCaptureOpenshell = deps.runCaptureOpenshell ?? makeRunCaptureOpenshell(openshell);

  for (const port of ports) {
    const result = bestEffortForwardStopForSandbox(
      runOpenshell,
      runCaptureOpenshell,
      port,
      sandboxName,
    );
    if (result === "stopped") {
      info(
        `Stopped ${displayName} host port forward ${String(port)} for sandbox '${sandboxName}'.`,
      );
    } else if (result === "owned-other") {
      warn(
        `Keeping ${displayName} host port forward ${String(port)}; it belongs to another sandbox.`,
      );
    } else if (result === "list-failed") {
      warn(
        `Could not enumerate OpenShell forwards; skipping ${displayName} host port forward ${String(
          port,
        )} cleanup.`,
      );
    }
  }
}
