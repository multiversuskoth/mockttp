/**
 * @module MockRule
 */

import * as _ from 'lodash';
import uuid = require("uuid/v4");

import { OngoingRequest, CompletedRequest, OngoingResponse, Explainable } from "../types";
import { waitForCompletedRequest } from '../util/request-utils';
import { MaybePromise } from '../util/type-utils';

import * as matchers from "./matchers";
import * as handlers from "./handlers";
import * as completionCheckers from "./completion-checkers";
import { validateMockRuleData } from './rule-serialization';

// The internal representation of a mocked endpoint
export interface MockRule extends Explainable {
    id: string;
    requests: Promise<CompletedRequest>[];

    // We don't extend the main interfaces for these, because MockRules are not Serializable
    matches(request: OngoingRequest): MaybePromise<boolean>;
    handle(request: OngoingRequest, response: OngoingResponse, record: boolean): Promise<void>;
    isComplete(): boolean | null;
}

export interface MockRuleData {
    id?: string;
    matchers: matchers.RequestMatcher[];
    handler: handlers.RequestHandler;
    completionChecker?: completionCheckers.RuleCompletionChecker;
}

export class MockRule implements MockRule {
    private matchers: matchers.RequestMatcher[];
    private handler: handlers.RequestHandler;
    private completionChecker?: completionCheckers.RuleCompletionChecker;

    public id: string;
    public requests: Promise<CompletedRequest>[] = [];
    public requestCount = 0;

    constructor(data: MockRuleData) {
        validateMockRuleData(data);

        this.id = data.id || uuid();
        this.matchers = data.matchers;
        this.handler = data.handler;
        this.completionChecker = data.completionChecker;
    }

    matches(request: OngoingRequest) {
        return matchers.matchesAll(request, this.matchers);
    }

    handle(req: OngoingRequest, res: OngoingResponse, record: boolean): Promise<void> {
        let completedPromise = (async () => {
            await this.handler.handle(req, res);
            return waitForCompletedRequest(req);
        })();

        // Requests are added to rule.requests as soon as they start being handled,
        // as promises, which resolve when the response is complete.
        if (record) {
            this.requests.push(completedPromise);
        }

        // Even if traffic recording is disabled, the number of matched
        // requests is still tracked
        this.requestCount += 1;

        return completedPromise as Promise<any>;
    }

    isComplete(): boolean | null {
        if (this.completionChecker) {
            return this.completionChecker.isComplete(this.requestCount);
        } else {
            return null;
        }
    }

    explain(withoutExactCompletion = false): string {
        let explanation = `Match requests ${matchers.explainMatchers(this.matchers)}, ` +
        `and then ${this.handler.explain()}`;

        if (this.completionChecker) {
            explanation += `, ${this.completionChecker.explain(
                withoutExactCompletion ? undefined : this.requestCount
            )}.`;
        } else {
            explanation += '.';
        }

        return explanation;
    }

    dispose() {
        this.handler.dispose();
        this.matchers.forEach(m => m.dispose());
        if (this.completionChecker) this.completionChecker.dispose();
    }
}