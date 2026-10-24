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
 * No real money moves: use a sandbox (test-mode) key throughout. If the
 * demo customer has no payment method, the Pro upgrade in step 4 returns a
 * payment URL instead of completing — open it, pay with a Stripe test
 * card, then run this script again.
 *
 * The script is safe to re-run. `track` has no idempotency key — a second
 * identical call deducts twice — so before every mutating step the script
 * reads the customer's current state and skips work that is already done.
 * That guard is application-level logic on purpose: duplicate protection
 * is your code's job, not the billing provider's.
 */

import { Autumn } from "autumn-js";

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

if (!secretKey.includes("_test")) {
	console.warn(
		"Warning: AUTUMN_SECRET_KEY does not look like a test-mode key " +
			"(expected am_sk_test_...). This example charges a real plan " +
			"upgrade — use a sandbox key.",
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

// Rollover caps from autumn.config.ts, per plan.
const ROLLOVER_CAP: Record<string, number> = { [STARTER]: 100, [PRO]: 500 };

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
	const usageSoFar = customer.balances?.[CREDITS]?.usage ?? 0;
	if (usageSoFar > 0) {
		// Re-run protection. `track` calls are not idempotent — without this
		// guard, running the script twice would deduct the demo spend twice.
		console.log(
			`  ${usageSoFar} credits already used — skipping the spend so a re-run does not double-count`,
		);
	} else {
		// Gate first, then track. You always pass the *underlying* feature;
		// Autumn converts the usage to credits (the check response's
		// `balances` map includes the linked credit system).
		const gate = await autumn.check({
			customerId: CUSTOMER_ID,
			featureId: PREMIUM_MODEL,
			requiredBalance: SPEND_PREMIUM, // can this customer afford 6 premium requests?
		});
		console.log(
			`  check premium_model x${SPEND_PREMIUM} → allowed: ${gate.allowed}`,
		);

		// `async: false` applies the usage before responding, so the printed
		// balances below are already up to date.
		await autumn.track({
			customerId: CUSTOMER_ID,
			featureId: BASIC_MODEL,
			value: SPEND_BASIC,
			async: false,
		});
		await autumn.track({
			customerId: CUSTOMER_ID,
			featureId: PREMIUM_MODEL,
			value: SPEND_PREMIUM,
			async: false,
		});
		console.log(
			`  tracked ${SPEND_BASIC} basic (${SPEND_BASIC} credits) + ${SPEND_PREMIUM} premium (${SPEND_PREMIUM * 10} credits)`,
		);
	}
	customer = await autumn.customers.get({ customerId: CUSTOMER_ID });
	printCreditBalance("after usage", customer);

	// ── Step 3 ──────────────────────────────────────────────────────────────
	heading("3", "Rollover at the monthly reset");
	const balanceNow = customer.balances?.[CREDITS];
	const planNow = currentPlanIds(customer)[0] ?? STARTER;
	const cap = ROLLOVER_CAP[planNow] ?? 0;
	if (balanceNow) {
		console.log(
			[
				"  Nothing to call here: rollover is configured on the plan item",
				"  (see autumn.config.ts — Starter rolls over up to 100 unused",
				"  credits, Pro up to 500; rolled-over credits expire after",
				"  1 month). When the cycle resets, Autumn grants the new",
				"  cycle's credits and carries the unused amount over as a",
				"  separate rollover balance instead of deleting it.",
				"",
				`  This customer currently has ${balanceNow.remaining} credits unused,`,
				`  so at the reset ${Math.min(balanceNow.remaining, cap)} of them would roll over`,
				`  (the ${planNow} cap is ${cap}); the rest expire.`,
				"",
				"  A script cannot fast-forward a billing cycle, so this step",
				"  only reads the live balance. Re-run this script after the",
				"  reset date printed as `resets at`, and the balance will show",
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
			"the plan swap. What this script did: gating, tracking — and the",
			"re-run guards, because `track` has no idempotency key.",
		].join("\n"),
	);
}

main().catch((err) => {
	console.error("\nScenario failed:", err);
	process.exit(1);
});
