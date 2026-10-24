/**
 * Worked example: AI credits with rollovers and a mid-cycle plan change.
 *
 * Runs the pricing declared in ../autumn.config.ts through the Autumn API
 * and narrates each step:
 *
 *   1. A customer lands on Starter (200 credits / month).
 *   2. They spend credits — basic requests cost 1 credit, premium requests
 *      cost 10, all from one shared pool.
 *   3. Rollover: what happens to unused credits when the month resets, and
 *      where to see it (the balance's `rollovers` breakdown).
 *   4. Mid-cycle, they upgrade Starter → Pro. Autumn charges for the plan
 *      change, and their remaining credits are carried over instead of
 *      being replaced by the new plan's grant.
 *
 * Before running:
 *   1. `npx atmn push`            — push ../autumn.config.ts to your sandbox
 *   2. `cp .env.example .env`     — add your sandbox secret key
 *   3. `npm run scenario`
 *
 * No real money moves: use a sandbox (test-mode) key throughout. The
 * script refuses to run against a non-test key unless you explicitly
 * opt in with AUTUMN_ALLOW_LIVE_KEY=1. If the demo customer has no
 * payment method, the Pro upgrade in step 4 returns a payment URL
 * instead of completing — open it, pay with a Stripe test card, then
 * run this script again.
 *
 * The script is safe to re-run. `track` has no idempotency key — a second
 * identical call deducts twice — so each completed `track` step is
 * recorded in a local state file (.demo-state.json, gitignored) and
 * skipped on later runs; the plan steps are guarded by the customer's
 * live state instead. Those guards are application-level logic on
 * purpose: duplicate protection is your code's job, not the billing
 * provider's.
 */

import { readFileSync, writeFileSync } from "node:fs";

import { Autumn } from "autumn-js";

import { credits as creditsFeature, pro, starter } from "../autumn.config.js";

const secretKey = process.env.AUTUMN_SECRET_KEY;

if (!secretKey) {
	console.error(
		[
			"Missing AUTUMN_SECRET_KEY.",
			"",
			"Create a sandbox in the Autumn dashboard, copy its secret key",
			"(am_sk_test_...), then run:",
			"",
			"  AUTUMN_SECRET_KEY=am_sk_test_... npm run scenario",
			"",
			"Also make sure you pushed the pricing config first:  npx atmn push",
		].join("\n"),
	);
	process.exit(1);
}

// Autumn keys encode their environment in the key itself: am_sk_test_...
// is a sandbox key, am_sk_live_... is production — the same split atmn's
// own isSandboxKey() makes. Step 4 charges for a plan upgrade, so a
// non-test key is refused by default; running against a live organisation
// takes an explicit opt-in.
const keyEnvironment = secretKey.split("am_sk_")[1]?.split("_")[0];
if (keyEnvironment !== "test") {
	if (process.env.AUTUMN_ALLOW_LIVE_KEY !== "1") {
		console.error(
			[
				"AUTUMN_SECRET_KEY is not a sandbox (test-mode) key.",
				"",
				"This example attaches a paid plan and records usage, so it",
				"refuses to run against a live organisation. Use a sandbox",
				"key (am_sk_test_...), or — only if you really mean it —",
				"opt in explicitly:",
				"",
				"  AUTUMN_ALLOW_LIVE_KEY=1 npm run scenario",
			].join("\n"),
		);
		process.exit(1);
	}
	console.warn(
		"WARNING: running with a non-sandbox key because " +
			"AUTUMN_ALLOW_LIVE_KEY=1 is set. Real charges will occur.",
	);
}

const autumn = new Autumn({ secretKey });

const CUSTOMER_ID = "demo_user_credits_example";
const STARTER = "starter";
const PRO = "pro";
const CREDITS = "credits";
const BASIC_MODEL = "basic_model";
const PREMIUM_MODEL = "premium_model";

// The demo spend in step 2: 40 basic (40 credits) + 6 premium (60 credits).
const SPEND_BASIC = 40;
const SPEND_PREMIUM = 6;

// Billing terms are read from autumn.config.ts, never restated here, so
// this script cannot silently drift from the config it narrates. (The
// atmn builders may emit camelCase or snake_case keys — accept either,
// as scripts/verify-config.ts does.)
function pickField(obj: any, ...keys: string[]): any {
	for (const key of keys) {
		if (obj && obj[key] !== undefined) return obj[key];
	}
	return undefined;
}

function creditCostOf(featureId: string): number {
	const schema =
		pickField(creditsFeature, "creditSchema", "credit_schema") ?? [];
	const entry = schema.find(
		(e: any) =>
			pickField(e, "meteredFeatureId", "metered_feature_id") ===
			featureId,
	);
	return pickField(entry, "creditCost", "credit_cost") ?? 0;
}

const BASIC_CREDIT_COST = creditCostOf(BASIC_MODEL);
const PREMIUM_CREDIT_COST = creditCostOf(PREMIUM_MODEL);

function rolloverOf(plan: any) {
	const itemDef = (plan?.items ?? []).find(
		(it: any) => pickField(it, "featureId", "feature_id") === CREDITS,
	);
	return itemDef ? pickField(itemDef, "rollover") : undefined;
}

const PLANS: Record<string, any> = { [STARTER]: starter, [PRO]: pro };
const ROLLOVER_CAP: Record<string, number> = {
	[STARTER]: rolloverOf(starter)?.max ?? 0,
	[PRO]: rolloverOf(pro)?.max ?? 0,
};

// ── Local completion state ────────────────────────────────────────────────
// Balance `usage` is scoped to the current billing cycle, so it cannot
// say whether the demo spend already happened in an earlier cycle. Each
// completed `track` step is therefore recorded in a small state file
// (gitignored) and consulted before tracking again.
const STATE_URL = new URL("../.demo-state.json", import.meta.url);

type DemoState = { customers: Record<string, Record<string, number>> };

function loadState(): DemoState {
	try {
		const parsed = JSON.parse(readFileSync(STATE_URL, "utf8"));
		if (parsed && typeof parsed === "object" && parsed.customers) {
			return parsed as DemoState;
		}
	} catch {
		// Missing or unreadable state file — start empty.
	}
	return { customers: {} };
}

function saveState(state: DemoState) {
	writeFileSync(STATE_URL, `${JSON.stringify(state, null, 2)}\n`);
}

function heading(step: string, title: string) {
	console.log(`\n── Step ${step}: ${title}`);
}

type Customer = Awaited<ReturnType<typeof autumn.customers.get>>;

/** Plan IDs with a live (not canceled) subscription, e.g. ["starter"]. */
function currentPlanIds(customer: Customer): string[] {
	return (customer.subscriptions ?? [])
		.filter((sub) => sub.canceledAt === null)
		.map((sub) => sub.planId);
}

/** Print the credit balance in a stable, readable shape. */
function printCreditBalance(context: string, customer: Customer) {
	const balance = customer.balances?.[CREDITS];

	if (!balance) {
		console.log(`  [${context}] no credit balance found`);
		return;
	}

	console.log(`  [${context}] credits balance:`);
	console.log(`    granted:   ${balance.granted}`);
	console.log(`    used:      ${balance.usage}`);
	console.log(`    remaining: ${balance.remaining}`);
	console.log(
		`    resets at: ${
			balance.nextResetAt
				? new Date(balance.nextResetAt).toISOString()
				: "never (one-off)"
		}`,
	);
	if (balance.rollovers && balance.rollovers.length > 0) {
		console.log(
			`    rolled over from previous cycles: ${JSON.stringify(balance.rollovers)}`,
		);
	}
	if (balance.breakdown && balance.breakdown.length > 0) {
		console.log(`    breakdown: ${JSON.stringify(balance.breakdown)}`);
	}
}

async function main() {
	// ── Step 1 ──────────────────────────────────────────────────────────────
	heading("1", "Customer starts on Starter (auto-enabled free plan)");
	let customer = await autumn.customers.getOrCreate({
		customerId: CUSTOMER_ID,
		name: "Demo User",
		email: "demo@example.com",
	});
	// Starter has `autoEnable: true` in the config, so a brand-new customer
	// already has it and there is nothing to attach. The explicit attach
	// below only runs for a customer who exists but has no plan yet — and
	// shows the call you would use for any plan that is not auto-enabled.
	if (currentPlanIds(customer).length === 0) {
		await autumn.billing.attach({
			customerId: CUSTOMER_ID,
			planId: STARTER,
		});
		customer = await autumn.customers.get({ customerId: CUSTOMER_ID });
	} else {
		console.log(
			`  already on plan(s): ${currentPlanIds(customer).join(", ")} — skipping attach`,
		);
	}
	printCreditBalance("after Starter attach", customer);

	// ── Step 2 ──────────────────────────────────────────────────────────────
	heading(
		"2",
		`Spend credits: ${SPEND_BASIC} basic requests + ${SPEND_PREMIUM} premium requests`,
	);
	const state = loadState();
	const steps = (state.customers[CUSTOMER_ID] ??= {});
	const basicStep = `track:${BASIC_MODEL}`;
	const premiumStep = `track:${PREMIUM_MODEL}`;

	// First run against this customer: adopt any usage the current cycle
	// already shows (e.g. from a run that pre-dates the state file) so it
	// is not tracked twice. The spend lands basic-first, so the cycle's
	// usage attributes unambiguously up to the full demo spend.
	if (steps[basicStep] === undefined && steps[premiumStep] === undefined) {
		const cycleUsage = customer.balances?.[CREDITS]?.usage ?? 0;
		if (cycleUsage > 0) {
			const basicDone = Math.min(
				SPEND_BASIC,
				Math.floor(
					Math.min(cycleUsage, SPEND_BASIC * BASIC_CREDIT_COST) /
						BASIC_CREDIT_COST,
				),
			);
			const premiumCredits =
				cycleUsage - basicDone * BASIC_CREDIT_COST;
			const premiumDone =
				premiumCredits % PREMIUM_CREDIT_COST === 0
					? Math.min(SPEND_PREMIUM, premiumCredits / PREMIUM_CREDIT_COST)
					: 0;
			if (basicDone > 0) steps[basicStep] = basicDone;
			if (premiumDone > 0) steps[premiumStep] = premiumDone;
			if (basicDone > 0 || premiumDone > 0) {
				saveState(state);
				console.log(
					`  adopted ${cycleUsage} credits of existing usage into .demo-state.json — it will not be tracked again`,
				);
			}
		}
	}

	const basicRemaining = SPEND_BASIC - (steps[basicStep] ?? 0);
	const premiumRemaining = SPEND_PREMIUM - (steps[premiumStep] ?? 0);

	if (basicRemaining <= 0 && premiumRemaining <= 0) {
		console.log(
			"  demo spend already tracked in an earlier run (recorded in .demo-state.json) — skipping",
		);
	} else {
		// Gate first, then track. You always pass the *underlying* feature;
		// Autumn converts the usage to credits (the check response's
		// `balances` map includes the linked credit system). If the gate
		// denies the spend, nothing is tracked and nothing is recorded —
		// fix the cause and re-run.
		const gateFeature = premiumRemaining > 0 ? PREMIUM_MODEL : BASIC_MODEL;
		const gateAmount =
			premiumRemaining > 0 ? premiumRemaining : basicRemaining;
		const gate = await autumn.check({
			customerId: CUSTOMER_ID,
			featureId: gateFeature,
			requiredBalance: gateAmount, // can this customer afford the remaining spend?
		});
		console.log(
			`  check ${gateFeature} x${gateAmount} → allowed: ${gate.allowed}`,
		);

		if (!gate.allowed) {
			console.log(
				"  check denied the spend — skipping the track calls, so no usage is recorded against a denied gate",
			);
		} else {
			// `async: false` applies the usage before responding, so the
			// balances printed below are already up to date. Each step is
			// recorded as soon as it lands, so a run that stops halfway
			// resumes with only the remainder.
			const tracked: string[] = [];
			if (basicRemaining > 0) {
				await autumn.track({
					customerId: CUSTOMER_ID,
					featureId: BASIC_MODEL,
					value: basicRemaining,
					async: false,
				});
				steps[basicStep] = SPEND_BASIC;
				saveState(state);
				tracked.push(
					`${basicRemaining} basic (${basicRemaining * BASIC_CREDIT_COST} credits)`,
				);
			}
			if (premiumRemaining > 0) {
				await autumn.track({
					customerId: CUSTOMER_ID,
					featureId: PREMIUM_MODEL,
					value: premiumRemaining,
					async: false,
				});
				steps[premiumStep] = SPEND_PREMIUM;
				saveState(state);
				tracked.push(
					`${premiumRemaining} premium (${premiumRemaining * PREMIUM_CREDIT_COST} credits)`,
				);
			}
			console.log(`  tracked ${tracked.join(" + ")}`);
		}
	}
	customer = await autumn.customers.get({ customerId: CUSTOMER_ID });
	printCreditBalance("after usage", customer);

	// ── Step 3 ──────────────────────────────────────────────────────────────
	heading("3", "Rollover at the monthly reset");
	const balanceNow = customer.balances?.[CREDITS];
	const planNow = currentPlanIds(customer)[0] ?? STARTER;
	const cap = ROLLOVER_CAP[planNow] ?? 0;
	const rolloverNow = rolloverOf(PLANS[planNow]);
	const expiryLength = rolloverNow
		? pickField(rolloverNow, "expiryDurationLength", "expiry_duration_length")
		: undefined;
	const expiryType = rolloverNow
		? pickField(rolloverNow, "expiryDurationType", "expiry_duration_type")
		: undefined;
	if (balanceNow) {
		console.log(
			[
				"  Nothing to call here: rollover is configured on the plan item",
				`  (see autumn.config.ts — ${STARTER} rolls over up to ${ROLLOVER_CAP[STARTER]} unused`,
				`  credits, ${PRO} up to ${ROLLOVER_CAP[PRO]}; rolled-over credits expire after`,
				`  ${expiryLength} ${expiryType}${expiryLength === 1 ? "" : "s"}). When the cycle resets, Autumn grants the new`,
				"  cycle's credits and carries the unused amount over as a",
				"  separate rollover balance instead of deleting it.",
				"",
				`  This customer currently has ${balanceNow.remaining} credits unused,`,
				`  so at the reset ${Math.min(balanceNow.remaining, cap)} of them would roll over`,
				`  (the ${planNow} cap is ${cap}); the rest expire.`,
				"",
				"  A script cannot fast-forward a billing cycle, so this step",
				"  only reads the live balance. Re-run this script after the",
				"  reset date printed as `resets at` — the spend is recorded",
				"  locally and will not repeat — and the balance will show",
				"  a `rollovers` breakdown with the carried-over amount.",
			].join("\n"),
		);
	}
	printCreditBalance("before upgrade", customer);

	// ── Step 4 ──────────────────────────────────────────────────────────────
	heading("4", "Mid-cycle upgrade: Starter → Pro, keeping the balance");
	if (currentPlanIds(customer).includes(PRO)) {
		console.log("  already on Pro — nothing to do");
	} else {
		// Same `attach` call as step 1 — Autumn works out that this is an
		// upgrade because both plans are in the same group (`ai_app`).
		// Per the SDK's AttachParams docs, plan changes take effect
		// immediately for upgrades and are scheduled for the end of the
		// cycle for downgrades (the `planSchedule` default), and
		// `carryOverBalances` keeps the customer's remaining credits —
		// including any rolled-over ones — instead of letting the new
		// plan's 1,000-credit grant simply replace the old balance.
		const upgrade = await autumn.billing.attach({
			customerId: CUSTOMER_ID,
			planId: PRO,
			carryOverBalances: { enabled: true, featureIds: [CREDITS] },
		});
		if (upgrade.invoice) {
			console.log(
				`  invoice created: ${upgrade.invoice.total} ${upgrade.invoice.currency}` +
					` (status: ${upgrade.invoice.status ?? "unknown"})`,
			);
		}
		if (upgrade.paymentUrl) {
			console.log(
				[
					"  payment required to finish the upgrade:",
					`    ${upgrade.paymentUrl}`,
					"  open it, pay with a Stripe test card, then re-run this",
					"  script — every step is state-guarded, so the re-run picks",
					"  up where this one left off instead of starting over.",
				].join("\n"),
			);
		} else if (upgrade.invoice) {
			console.log(
				"  upgrade applied and charged — no payment action needed",
			);
		}
	}
	customer = await autumn.customers.get({ customerId: CUSTOMER_ID });
	printCreditBalance("after Pro upgrade", customer);

	console.log(
		[
			"",
			"Done. The three cases, in one customer:",
			"  1. one credit pool, two features drawing at different rates;",
			"  2. unused credits roll over at reset (capped, with an expiry)",
			"     instead of vanishing;",
			"  3. a mid-cycle plan change carries the remaining balance over",
			"     — no product/price-ID rip-out in your own code, because",
			"     attach/check/track never change.",
			"",
			"What Autumn did: metering conversion, the rollover at reset,",
			"the plan swap. What this script did: gating, tracking — and",
			"the local completion state, because `track` has no idempotency key.",
		].join("\n"),
	);
}

main().catch((err) => {
	console.error("\nScenario failed:", err);
	process.exit(1);
});
