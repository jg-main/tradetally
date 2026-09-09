# TradeTally — Versioned Setup-Specific Quality Profiles

## Status

**Specification:** Approved design baseline  
**Primary first profile:** Canonical BO / Qullamägi Breakout  
**Scope:** TradeTally customization only  
**Implementation branch:** `custom`  
**Out of scope:** ClickHouse, QuantSpace data platform integration, new external market-data vendors, custom rule scripting/DSL, screenshot AI grading

---

# 1. Objective

Replace or extend TradeTally's current global/instrument-level **Setup Quality** grading so that quality can be evaluated **per setup/profile**.

The new framework must independently evaluate:

```text
SETUP QUALITY
ENTRY QUALITY
MANAGEMENT QUALITY
```

Each dimension must expose:

```text
Score       0–100
Grade       A / B / C / D / F
Compliance  PASS / FAIL / INCOMPLETE
Coverage    0–100%
```

Trade outcome must remain independent:

```text
OUTCOME
R multiple
PnL
MFE
MAE
```

A losing trade can be an A-quality setup and correctly executed.  
A profitable trade can be a poor setup or poorly executed.

There must be **no combined overall quality score** that mixes Setup, Entry, Management, and Outcome.

---

# 2. Core design principles

## 2.1 Profiles, not hard-coded strategies

Every trading-policy value defined in this document is a **default parameter in a quality profile**, not a constant buried in application logic.

Example:

```text
Canonical BO default:
minimum_prior_move_pct = 30
minimum_base_sessions  = 10
maximum_base_sessions  = 40
```

The application may hard-code mathematical definitions and criterion evaluator types, but not user trading-policy thresholds.

Every criterion must support, where applicable:

```text
enabled
required
weight
parameters
scoring
missing_data_behavior
```

---

## 2.2 Typed configuration, not arbitrary code

Do not implement user-entered JavaScript, Python, SQL, expressions, or a general DSL.

Use structured criterion types and validated parameters.

Example:

```json
{
  "key": "range_contraction",
  "enabled": true,
  "required": true,
  "weight": 15,
  "parameters": {
    "recent_window": 5,
    "prior_window": 10,
    "maximum_ratio": 0.7,
    "require_full_windows": true
  }
}
```

---

## 2.3 Post-trade evaluation, point-in-time evidence

Quality evaluation is performed **post-trade**.

However, when the criterion evaluates the setup or decision at entry, evidence must be anchored to information that was observable at the relevant historical time.

Do not use later information to improve or damage Entry Quality.

Examples:

- Initial stop uses the LOD observable when the stop was established, not the final LOD of the day.
- Breakout volume pace at 10:35 must not use volume printed later in the session.
- Range expansion at entry must not use afternoon movement.
- Trade outcome must never influence quality scoring.

---

## 2.4 No manual entry of machine-observable metrics

Do not ask the user to manually type:

```text
ATR
ADR
SMA
RVOL
gap %
range contraction
volume contraction
distance from pivot
base depth
MFE
MAE
```

These must come from:

1. Trade/execution data already in TradeTally.
2. Existing TradeTally market-data providers.
3. Deterministic calculations derived locally from those data.

Manual input is appropriate only for inherently semantic/discretionary information.

Canonical BO manual/hybrid inputs include:

```text
Leader confirmation
Base Start confirmation/adjustment
Pivot confirmation/adjustment
Intended trigger type
Trailing MA selection: SMA10 or SMA20
```

---

## 2.5 Existing TradeTally market data only

Do not add ClickHouse support.

Do not add QuantSpace data access.

Do not add Polygon or another new market-data vendor as part of this feature.

Use TradeTally's existing market-data abstraction and providers.

Current TradeTally code already supports market-data routing through existing providers including Finnhub/FMP and candle retrieval.

The feature should use those existing sources and existing fallback behavior where appropriate.

If evidence cannot be obtained from available TradeTally sources:

```text
UNKNOWN
```

Do not fabricate a value and do not force technical manual entry.

---

# 3. Integrate with existing TradeTally concepts

TradeTally already has:

- `playbooks`
- playbook checklist items
- playbook adherence reviews
- existing Setup Quality fields and quality calculation service

The new Quality Profile system should integrate with existing Playbooks rather than create a duplicate strategy taxonomy.

Recommended relationship:

```text
Playbook
   │
   └── optional Quality Profile
```

Example:

```text
Playbook: Breakout
Quality Profile: Canonical BO
```

A Quality Profile may also exist without being linked to a Playbook.

Do not force quantitative quality criteria into the existing simple playbook checklist model.

---

# 4. Quality Profile versioning

Quality Profiles must be versioned.

Example:

```text
Breakout
├── v1
├── v2
└── v3  ← current
```

Editing a profile must create a **new immutable version**.

Existing historical evaluations must not silently change when profile settings change.

Example:

```text
Trade A
Evaluated with Breakout v1
Score: 91
```

If the user later changes:

```text
Prior Move minimum: 30% → 40%
Base duration: 10–40 → 8–30
```

Trade A remains evaluated under v1.

The UI may offer:

```text
Evaluate with current version
```

which creates a new evaluation instead of overwriting the old one.

---

# 5. Persistence model

The exact migration implementation may adapt to the existing schema, but the following logical model is required.

## 5.1 `quality_profiles`

Suggested fields:

```text
id
user_id
name
description
playbook_id nullable
instrument_type nullable
is_active
current_version_id
created_at
updated_at
```

Examples:

```text
Canonical BO
Breakout — Aggressive
Breakout — Conservative
Episodic Pivot
```

---

## 5.2 `quality_profile_versions`

Immutable configuration snapshots.

Suggested fields:

```text
id
profile_id
version_number
schema_version
configuration JSONB
created_at
```

Unique:

```text
(profile_id, version_number)
```

Suggested configuration structure:

```text
dimensions
├── setup
│   ├── minimum_coverage
│   ├── grade_thresholds
│   └── criteria[]
├── entry
│   ├── minimum_coverage
│   ├── grade_thresholds
│   └── criteria[]
└── management
    ├── minimum_coverage
    ├── grade_thresholds
    └── criteria[]
```

Criterion structure:

```text
key
enabled
required
weight
parameters
scoring
```

---

## 5.3 `trade_quality_evaluations`

Suggested fields:

```text
id
user_id
trade_id
profile_version_id

status
setup_score
setup_grade
setup_compliance
setup_coverage

entry_score
entry_grade
entry_compliance
entry_coverage

management_score
management_grade
management_compliance
management_coverage

user_inputs JSONB
detected_context JSONB
evidence_snapshot JSONB
results JSONB

evaluated_at
created_at
```

Suggested evaluation statuses:

```text
draft
needs_input
completed
insufficient_data
error
```

---

# 6. Evaluation immutability

A completed evaluation must preserve the evidence snapshot used at evaluation time.

Example:

```text
Profile: Canonical BO v1
Evaluated: 2026-09-09

Detected Base Start:   2026-08-18
Confirmed Base Start:  2026-08-18

Detected Pivot:        $70.65
Confirmed Pivot:       $70.72

Leader:                user-confirmed YES

Prior Move:            +52.1%
Range Contraction:     0.48
Volume Contraction:    0.61
...
```

Later provider responses or recalculated market history must not silently mutate this evaluation.

A new calculation creates a new evaluation record.

---

# 7. Criterion states

Every criterion evaluation must use explicit states.

```text
PASS
FAIL
NOT_APPLICABLE
UNKNOWN
```

## 7.1 PASS

Evidence exists and the required/compliance rule passes.

## 7.2 FAIL

Evidence exists and the configured rule explicitly fails.

## 7.3 NOT_APPLICABLE

The rule legitimately never became applicable.

Example:

```text
Partial condition:
day in [3,5] AND MFE >= 1R

MFE never reaches +1R by Day 5
→ Partial rule is NOT_APPLICABLE
```

`NOT_APPLICABLE`:

- must not count as failure
- must not reduce data coverage
- must be removed from the applicable scoring denominator

## 7.4 UNKNOWN

The rule applies, but TradeTally cannot obtain enough evidence.

Examples:

```text
Stop history unavailable
Intraday candles unavailable
Base too short for configured full contraction windows
```

`UNKNOWN`:

- must not be treated as FAIL
- must reduce evidence coverage
- if required, prevents Compliance from being PASS

---

# 8. Dimension compliance

Each dimension has independent compliance.

## PASS

All applicable required criteria are known and pass.

## FAIL

At least one applicable required criterion explicitly fails.

## INCOMPLETE

No applicable required criterion is known to fail, but at least one applicable required criterion is UNKNOWN.

Example:

```text
SETUP QUALITY
A / 91

Compliance: FAIL

Reason:
Prior Move = +27%
Required >= 30%
```

The numerical score is not overridden by compliance.

---

# 9. Score calculation

For each dimension:

\[
Quality =
\frac{\sum Score_i \times Weight_i}
{\sum AvailableApplicableWeight_i}
\]

Rules:

- `PASS` and `FAIL` criteria contribute their numerical quality score.
- `UNKNOWN` criteria are removed from the score denominator but reduce coverage.
- `NOT_APPLICABLE` criteria are removed from both the score denominator and the applicable-weight coverage denominator.

Canonical minimum coverage:

```text
70%
```

Profile-configurable.

Below configured minimum coverage:

```text
Score: N/A
Grade: N/A
```

Compliance may still be FAIL if a known required criterion explicitly failed.

---

# 10. Grade thresholds

Canonical default:

```text
A >= 90
B >= 80
C >= 70
D >= 60
F < 60
```

Configurable at profile/dimension level if desired.

---

# 11. Canonical BO definition

A Canonical BO is:

> A leading stock that has made a substantial prior advance, then formed an orderly multi-week consolidation characterized by higher lows, contracting price ranges and declining volume, while maintaining its intermediate-term uptrend, and is attempting to resolve above a clear pivot.

Canonical characteristics:

```text
Leadership / leader confirmation
Prior move >= 30%
Prior impulse roughly within prior 1–3 months
Base duration 10–40 sessions
Higher structural lows
Range contraction
Volume contraction
Rising SMA10 / SMA20
Price supported near SMA20
Clear pivot
Breakout through pivot
```

All values are configurable defaults.

---

# 12. Canonical BO — Setup Quality

## 12.1 Default weights

| Criterion           |   Weight | Required |
| ------------------- | -------: | :------: |
| Leader              |      20% |   Yes    |
| Prior Move          |      20% |   Yes    |
| Base Duration       |       5% |   Yes    |
| Higher Lows         |      10% |   Yes    |
| Range Contraction   |      15% |   Yes    |
| Volume Contraction  |      15% |   Yes    |
| SMA Trend Structure |       5% |   Yes    |
| Pivot Quality       |      10% |   Yes    |
| **Total**           | **100%** |          |

---

# 13. Leader

Canonical source:

```text
User assertion
```

UI:

```text
Is this stock a leader?
☐ Yes
```

Do not fabricate a cross-sectional RS percentile.

Do not silently replace canonical top-1–2% RS with absolute return.

Scoring:

```text
YES = 100
NO  = 0
```

Compliance:

```text
YES = PASS
NO  = FAIL
```

Store provenance:

```text
source = user_asserted
```

---

# 14. Prior Move

## 14.1 Definition

> Prior Move is the percentage advance from the most recent qualifying structural swing low preceding the base to the confirmed pivot.

Formula:

\[
PriorMovePct =
\left(
\frac{ConfirmedPivot}{ImpulseLow} - 1
\right)
\times 100
\]

## 14.2 Canonical detection defaults

Search:

```text
60 trading sessions before confirmed Base Start
```

Structural swing low at day `i`:

```text
low[i] < lows of previous 3 sessions
AND
low[i] <= lows of following 3 sessions
```

Among qualifying swing lows producing at least the configured minimum Prior Move, choose:

```text
most recent qualifying swing low
```

Canonical minimum:

```text
30%
```

Do not select an older low simply because it produces a larger percentage gain.

## 14.3 Stored evidence

```text
impulse_low_date
impulse_low_price
confirmed_pivot
prior_move_pct
prior_move_duration_sessions
```

Optional user correction:

```text
Adjust detected impulse low
```

not required by default.

## 14.4 Compliance

```text
Prior Move >= 30% → PASS
Prior Move < 30%  → FAIL
```

## 14.5 Canonical scoring

```text
< 20%       0
20–<30%    40
30–<40%    60
40–<60%    80
60–<100%   90
>=100%    100
```

All thresholds configurable.

---

# 15. Base Start / Base Duration

## 15.1 Base Start definition

> Base Start is the earliest significant daily swing high marking the transition from the impulse advance into the consolidation that persists until breakout.

Search horizon:

```text
60 sessions
```

Structural swing high at `i`:

```text
high[i] > highs of previous 3 sessions
AND
high[i] >= highs of following 3 sessions
```

A swing high qualifies as a candidate Base Start if from that session through D-1:

```text
maximum subsequent high
<= candidate_high × 1.05
```

Canonical post-high allowance:

```text
5%
```

If multiple candidates qualify:

```text
choose earliest qualifying candidate
```

Do not optimize the Base Start to force duration into the canonical window.

## 15.2 Confirmation UI

```text
Detected Base Start
Aug 18, 2026

[ Confirm ] [ Adjust ]
```

Persist:

```text
base_start_detected
base_start_confirmed
base_start_source
```

Once confirmed, the confirmed value becomes authoritative for downstream structural calculations.

## 15.3 Base End

```text
D-1
```

The breakout day is excluded from the base.

## 15.4 Base Duration

Number of trading sessions from confirmed Base Start through D-1 inclusive.

Canonical valid range:

```text
10–40 trading sessions
```

## 15.5 Scoring

Binary v1:

```text
10–40 sessions → 100
otherwise      → 0
```

A 47-session base must remain 47 sessions and fail. Do not truncate it.

---

# 16. Higher Lows

## 16.1 Scope

Evaluate only inside:

```text
Confirmed Base Start → D-1
```

## 16.2 Structural swing-low detection

Canonical defaults:

```text
left_window  = 2
right_window = 2
```

Structural swing low at `i`:

```text
low[i] < lows of previous 2 sessions
AND
low[i] <= lows of following 2 sessions
```

Minimum structural lows:

```text
2
```

## 16.3 Tolerance

Canonical:

```text
0.5%
```

A later low is considered non-lower if:

\[
L*n \ge L*{n-1}(1 - tolerance)
\]

## 16.4 Compliance

Canonical:

```text
No material lower structural swing low
```

Any material lower swing low causes FAIL.

If fewer than the configured minimum structural lows are detected:

```text
UNKNOWN
```

not FAIL.

## 16.5 Quality score

\[
score =
100 \times
\frac{non_lower_transitions}{total_transitions}
\]

Example:

```text
2 passing transitions / 3 total = 66.7
```

Store all detected lows and transitions.

---

# 17. Range Contraction

## 17.1 Definition

Compare the total high-to-low span of the final recent base window with the immediately preceding comparison window.

Canonical defaults:

```text
recent_window = 5
prior_window  = 10
maximum_ratio = 0.70
require_full_windows = true
```

For each window:

\[
Range(W) = max(High_W) - min(Low_W)
\]

Then:

\[
ContractionRatio =
\frac{RecentRange}{PriorRange}
\]

## 17.2 Window placement

```text
Confirmed Base Start

|------ prior 10 ------|-- recent 5 --| breakout
                                      D-1
```

Both windows must lie fully inside the confirmed base.

Do not reach backward into the impulse to fill missing sessions.

If insufficient base sessions:

```text
UNKNOWN
```

## 17.3 Compliance

```text
ratio <= 0.70 → PASS
ratio > 0.70  → FAIL
```

## 17.4 Canonical scoring

```text
<=0.40        100
>0.40–0.55     90
>0.55–0.70     75
>0.70–0.85     50
>0.85–1.00     25
>1.00            0
```

---

# 18. Volume Contraction

## 18.1 Definition

Compare average daily share volume in the final recent base window with the immediately preceding comparison window.

Canonical defaults:

```text
recent_window = 5
prior_window  = 10
maximum_ratio = 0.70
require_full_windows = true
```

Formula:

\[
VolumeRatio =
\frac{AvgVolume*{recent}}
{AvgVolume*{prior}}
\]

Use:

```text
share volume
arithmetic mean
actual historical values
```

Do not winsorize or automatically remove volume spikes.

Breakout-day volume is excluded.

Both windows must lie fully inside the confirmed base.

Insufficient base history:

```text
UNKNOWN
```

## 18.2 Compliance

```text
ratio <= 0.70 → PASS
ratio > 0.70  → FAIL
```

## 18.3 Canonical scoring

```text
<=0.40        100
>0.40–0.55     90
>0.55–0.70     75
>0.70–0.85     50
>0.85–1.00     25
>1.00            0
```

---

# 19. SMA Trend Structure

## 19.1 Canonical defaults

```text
MA type              SMA
Fast period          10
Slow period          20
Slope lookback       5 sessions
Support MA           SMA20
Max close below MA   2.0%
Require SMA10>SMA20  No
Evaluation date      D-1
```

Formula:

\[
SMA*n(t) =
\frac{1}{n}\sum*{i=0}^{n-1} Close\_{t-i}
\]

Rising criteria:

```text
SMA10(D-1) > SMA10(D-6)
SMA20(D-1) > SMA20(D-6)
```

Support:

\[
Close*{D-1}
\ge
SMA20*{D-1} \times 0.98
\]

## 19.2 Compliance

Canonical requires all three:

```text
SMA10 rising
SMA20 rising
D-1 close not more than 2% below SMA20
```

Do not require SMA10 > SMA20 by default.

## 19.3 Scoring

```text
3/3 = 100
2/3 = 67
1/3 = 33
0/3 = 0
```

If profile enables MA ordering, it becomes an additional configured subcomponent.

---

# 20. Pivot Detection

Pivot Detection and Pivot Quality are separate concepts.

Detection confidence must not affect the quality grade.

## 20.1 Definition

> The pivot is the upper resistance boundary of the final consolidation that price must clear for the BO to resolve upward.

Search only inside:

```text
Confirmed Base Start → D-1
```

## 20.2 Structural high detection

Canonical:

```text
left_window  = 2
right_window = 2
```

Structural swing high:

```text
high[i] > highs of previous 2 sessions
AND
high[i] >= highs of following 2 sessions
```

## 20.3 Resistance clustering

Canonical:

```text
cluster_tolerance = 2.0%
minimum_touches   = 2
recent_touch_window = 10 sessions
```

A qualifying cluster must contain at least one structural high during the final configured recent-touch window.

If multiple clusters qualify:

```text
select highest qualifying resistance cluster
```

Detected pivot:

```text
highest high in selected cluster
```

## 20.4 Fallback detection

If no qualifying cluster exists:

1. highest structural swing high in final recent window
2. otherwise highest daily high in final recent window

Flag lower detection confidence.

Do not treat low detector confidence as low setup quality.

## 20.5 Confirmation UI

```text
Detected pivot: $70.72

[ Confirm $70.72 ] [ Adjust ]
```

Persist:

```text
pivot_detected
pivot_confirmed
pivot_source
detection_confidence
```

Confirmed pivot becomes authoritative for downstream calculations.

---

# 21. Pivot Quality

Canonical compliance components:

```text
minimum resistance touches >= 2
at least one recent touch within final 10 sessions
D-1 close no more than 5% below confirmed pivot
no prior daily close more than 1% above confirmed pivot
```

All configurable.

## 21.1 Pivot-touch qualification

A structural high counts as a touch if it lies within configured tolerance of the confirmed pivot.

Canonical:

```text
2.0%
```

## 21.2 D-1 pivot proximity

\[
PivotDistancePct =
\frac{Pivot - Close\_{D-1}}{Pivot}
\]

Canonical:

```text
<=5%
```

## 21.3 Prior-resolution tolerance

Canonical:

```text
No pre-breakout close > Pivot + 1%
```

If user confirms a one-touch pivot:

```text
Pivot exists
Pivot Quality may FAIL
```

Do not mark UNKNOWN solely because the user confirmed a noncanonical pivot.

## 21.4 Composite quality scoring

Canonical subweights:

```text
Resistance touches       30%
Recent touch             20%
D-1 proximity            30%
No prior resolution      20%
```

Suggested touch score:

```text
0 touches    0
1 touch     40
2 touches   80
>=3        100
```

Recent touch:

```text
YES 100
NO    0
```

Pivot proximity:

```text
<=2%           100
2–5%           linear 100 → 70
5–10%          linear 70 → 0
>10%             0
```

No prior material close above pivot:

```text
YES 100
NO    0
```

---

# 22. Canonical BO — Entry Quality

## 22.1 Default weights

| Criterion                   |   Weight | Required |
| --------------------------- | -------: | :------: |
| Breakout-session compliance |      10% |   Yes    |
| Trigger compliance          |      20% |   Yes    |
| Volume Pace at Entry        |      10% |    No    |
| Range Pace at Entry         |       5% |    No    |
| Entry Extension             |      20% |    No    |
| Initial Stop Placement      |      20% |   Yes    |
| Stop Width / Volatility     |      15% |   Yes    |
| **Total**                   | **100%** |          |

---

# 23. Breakout Session

Definition:

> First trading session after the confirmed base in which price trades above the confirmed pivot.

Store separately:

```text
breakout_session
actual_entry_session
```

Canonical compliance:

```text
actual_entry_session == breakout_session
```

Scoring:

```text
YES 100
NO    0
```

A later trade must not cause the later date to be redefined as the breakout date.

---

# 24. Entry Trigger

Supported canonical trigger types:

```text
BO-PIVOT
BO-ORH-1
BO-ORH-5
BO-ORH-60
```

The configured/intended trigger must be stored on the trade/evaluation.

Do not retrospectively relabel the trigger to improve compliance.

## 24.1 Direct Pivot

```text
TriggerPrice = ConfirmedPivot
```

## 24.2 Opening Range

Use regular-session exchange time.

Canonical U.S. equity examples:

```text
BO-ORH-1   09:30–09:31 ET
BO-ORH-5   09:30–09:35 ET
BO-ORH-60  09:30–10:30 ET
```

Market calendars should be used for session-date correctness.

For ORH:

\[
EffectiveTrigger =
max(ConfirmedPivot, OpeningRangeHigh)
\]

The ORH trigger is invalid until the configured opening range has completed.

## 24.3 Trigger crossing

Canonical:

```text
first trade > effective trigger
minimum penetration = 0%
```

Store:

```text
trigger_type
trigger_price
trigger_time
entry_time
entry_price
trigger_cross_number
minutes_after_first_trigger
```

Do not automatically fail second-break entries in v1; retain them as evidence unless the profile explicitly requires first break.

Canonical quality scoring for Trigger Compliance (binary; no partial credit):

```text
PASS → 100
FAIL → 0
```

UNKNOWN / NOT_APPLICABLE carry no numeric score, and compliance remains independent of the numerical quality score.

---

# 25. Entry Extension

Calculate both:

\[
TriggerExtensionPct =
\left(
\frac{EntryBasis}{EffectiveTrigger} - 1
\right)
\times 100
\]

and:

\[
PivotExtensionPct =
\left(
\frac{EntryBasis}{ConfirmedPivot} - 1
\right)
\times 100
\]

Primary cross-stock measure:

\[
ExtensionADR =
\frac{EntryBasis - EffectiveTrigger}{ADR\$}
\]

Canonical scoring:

```text
<=0.05 ADR       100
>0.05–0.10        90
>0.10–0.20        75
>0.20–0.30        50
>0.30–0.50        25
>0.50               0
```

There is **no canonical hard extension compliance limit in v1**.

The profile must support adding one later.

---

# 26. Breakout Volume Pace

Do not use completed-day volume to grade an intraday entry.

At actual entry time:

\[
VolumePace =
\frac{CumulativeVolumeTodayAtEntry}
{ExpectedHistoricalVolumeAtSameElapsedTime}
\]

Canonical historical reference:

```text
20 previous regular sessions
```

Canonical target:

```text
>=1.40x
```

Scoring:

```text
<0.80x       0
0.80–<1.00  25
1.00–<1.40  60
1.40–<2.00  85
>=2.00     100
```

Not required for canonical Entry Compliance v1.

If sufficient intraday data are unavailable:

```text
UNKNOWN
```

Do not substitute completed full-day volume.

Completed breakout-day volume may be stored as research evidence only.

---

# 27. Breakout Range Pace

Use same-time historical range context rather than completed-day range.

At entry:

\[
TodayRangeAtEntry =
HighestPriceFromOpenToEntry

- LowestPriceFromOpenToEntry
  \]

\[
RangePace =
\frac{TodayRangeAtEntry}
{ExpectedHistoricalRangeAtSameElapsedTime}
\]

Canonical reference:

```text
20 previous regular sessions
```

Scoring:

```text
<0.75x       0
0.75–<1.00  40
1.00–<1.25  70
1.25–<1.50  90
>=1.50     100
```

Not required for compliance.

Also retain:

```text
range_at_entry / ADR20
```

as research evidence.

---

# 28. Initial Entry Basis and Original Position

## 28.1 Original Position

> All opening-side fills before the first position reduction.

Example:

```text
Buy 100
Buy 100
Buy 50
Sell 125  ← first reduction

Original position = 250
```

## 28.2 Entry Basis

Quantity-weighted average price of all opening fills before the first reduction.

\[
EntryBasis =
\frac{\sum Price_i \times Qty_i}
{\sum Qty_i}
\]

This immutable original entry basis is used for:

```text
Initial R
MFE in R
MAE in R
Breakeven reference
Partial calculations
```

---

# 29. Initial Stop

## 29.1 Definition

> First protective stop associated with the opening position.

If a separate stop-establishment timestamp exists:

```text
reference_time = stop_establishment_time
```

otherwise:

```text
reference_time = entry_time
```

## 29.2 Observable LOD

Use regular-session market data from session open through reference time.

\[
LOD\_{observable}
=
min(Low_t), t \le reference_time
\]

Later lows must not affect the grade.

## 29.3 Buffer

Canonical rule:

\[
InitialStop
\le
LOD\_{observable} - Buffer
\]

Buffer must be profile-configurable.

Supported methods should include:

```text
minimum tick
fixed dollars
percentage
ATR fraction
ADR fraction
```

Canonical mechanical default:

```text
1 valid price increment
```

## 29.4 Compliance

```text
stop below observable LOD by required buffer → PASS
otherwise                                   → FAIL
```

If actual initial stop cannot be established:

```text
UNKNOWN
```

Do not infer that the user's real stop was the rule-based reference stop.

A reference/hypothetical stop may be displayed separately.

Canonical quality scoring for Initial Stop (binary; no partial credit):

```text
PASS → 100
FAIL → 0
```

UNKNOWN / NOT_APPLICABLE carry no numeric score, and compliance remains independent of the numerical quality score.

---

# 30. Initial R

For a long BO:

\[
R\_{per\ share}
=
EntryBasis - InitialStop
\]

Trade-level planned risk:

\[
InitialRiskDollars =
R\_{per\ share} \times OriginalPositionQty
\]

Once established:

```text
Initial R is immutable
```

Later stop changes must never redefine R.

All R-normalized analytics use the original R.

---

# 31. Stop Width

The structural stop rule and the stop-width rule are separate.

\[
StopWidth =
EntryBasis - InitialStop
\]

Canonical volatility reference:

```text
ADR20
```

Canonical ADR percentage:

\[
DailyRangePct =
\frac{High - Low}{PreviousClose}
\]

\[
ADR20Pct =
Mean(DailyRangePct\_{last 20})
\]

\[
ADR\$ =
EntryBasis \times ADR20Pct
\]

Then:

\[
StopWidthRatio =
\frac{StopWidth}{ADR\$}
\]

Canonical compliance:

```text
StopWidthRatio <= 1.00
```

Canonical scoring:

```text
<=0.50 ADR      100
>0.50–0.75       90
>0.75–1.00       75
>1.00–1.25       40
>1.25              0
```

Profiles may choose ATR instead.

If ATR is selected:

\[
TR_t =
max(
High-Low,
|High-PrevClose|,
|Low-PrevClose|
)
\]

with configurable ATR period.

---

# 32. Canonical Entry Compliance

Required canonical conditions:

```text
Correct breakout session
Correct configured trigger
Initial stop correctly below observable LOD + buffer
Stop width <= configured maximum volatility multiple
```

Volume Pace, Range Pace, and Entry Extension affect quality but are not required compliance conditions in canonical v1 unless the user enables required thresholds.

---

# 33. Canonical BO — Management Quality

## 33.1 Default weights

| Criterion                         |   Weight |      Required       |
| --------------------------------- | -------: | :-----------------: |
| Partial Timing                    |      20% | Yes when applicable |
| Partial Sizing                    |      15% | Yes when applicable |
| No Premature Reduction            |      10% |         Yes         |
| Stop Ratchet / Never Lower        |      20% |         Yes         |
| Post-Partial Breakeven Protection |      15% | Yes when applicable |
| Selected MA Trailing Exit         |      20% | Yes when applicable |
| **Total**                         | **100%** |                     |

---

# 34. Management Day Count

Canonical:

```text
Day 1 = trading session containing initial entry
Day 2 = next trading session
...
```

Weekends and market holidays do not count.

Management day count is anchored to the actual initial entry session.

---

# 35. MFE in R

For a long:

\[
MFE_R(t) =
\frac{
HighestPriceSinceEntry(t) - EntryBasis
}{
InitialR
}
\]

MFE is cumulative.

It never resets by session.

---

# 36. Required 50% Partial

Canonical parameters:

```text
partial_pct       = 50%
earliest_day      = 3
latest_day        = 5
minimum_mfe       = 1.0R
completion_window = same regular session
```

Trigger condition:

\[
day \in [3,5]
AND
MFE \ge 1R
\]

The first moment both conditions are true establishes the required partial.

## 36.1 +1R before Day 3

If MFE reaches +1R on Day 1 or Day 2:

```text
partial becomes required on Day 3
```

No second +1R touch is required on Day 3.

## 36.2 +1R during Day 3–5

Example:

```text
Day 4 11:17
MFE reaches +1R
```

The partial becomes required at that timestamp.

Canonical deadline:

```text
end of that same regular trading session
```

## 36.3 No +1R by Day 5

If +1R is never reached through Day 5:

```text
Partial Timing = NOT_APPLICABLE
Partial Sizing = NOT_APPLICABLE
Post-Partial BE = NOT_APPLICABLE
```

A +1R print on Day 6 does not retroactively trigger the canonical partial rule.

---

# 37. Partial Quantity

Canonical:

```text
50% of original position
```

\[
RequiredPartialQty =
OriginalPositionQty \times 0.50
\]

Round only as required by the instrument's valid tradable unit.

Multiple fills may satisfy the partial.

Example:

```text
Original: 200
Sell 40
Sell 35
Sell 25

Total partial = 100
```

---

# 38. Partial Timing Scoring

Canonical:

```text
Completed same trigger session    100
Completed next session             50
Later / not completed               0
```

Canonical Compliance requires:

```text
same trigger session
```

The partial timing policy is configurable.

---

# 39. Partial Sizing Scoring

Canonical target:

```text
50%
```

Suggested quality curve:

```text
48–52%             100
45–<48 / >52–55     90
40–<45 / >55–60     70
30–<40 / >60–70     40
<30 / >70             0
```

Compliance uses the configured target/tolerance policy.

Quantity rounding must not create a false failure.

---

# 40. Premature Reduction

Before the canonical partial trigger occurs:

```text
position should remain at original size
```

unless reduced by a legitimate protective stop.

Any discretionary reduction before trigger:

```text
Compliance = FAIL
```

Canonical scoring:

```text
0% early        100
>0–10%           75
>10–25%          50
>25%               0
```

If the trader sold early and later reaches the 50% remaining target, evaluate separately:

```text
Partial target compliance
Premature reduction compliance
```

Do not require another 50% sale that would reduce the trade below the intended remaining 50%.

---

# 41. Stop Ratchet / Never Lower

Canonical long rule:

\[
S*t \ge S*{t-1}
\]

for every logical protective stop change.

Allowed:

```text
unchanged
higher
```

Forbidden:

```text
lower
```

Example:

```text
69.30 → 71.00 → 70.50
```

FAIL, even though 70.50 remains above the original 69.30.

Canonical tolerance:

```text
0 downward valid ticks
```

Normalize prices to valid instrument tick size before comparison.

## 41.1 Logical stop history

Broker cancel/replace noise must be reconstructed as logical stop modifications.

Do not treat:

```text
cancel old stop
submit replacement
```

as an intentional unprotected interval for the ratchet comparison itself.

## 41.2 Multiple active stops

When multiple protective stops exist:

```text
effective_stop_floor =
lowest active protective stop covering any portion of remaining long position
```

Use changes in this effective floor for ratchet compliance.

## 41.3 Stop execution

Stop execution price is not a stop modification.

Do not compare fill slippage to prior stop level as if the stop had been lowered.

## 41.4 Missing stop history

If complete stop-order history is unavailable:

```text
Stop Ratchet = UNKNOWN
```

Do not infer PASS from a reasonable final exit.

Optional manual fallback may later be supported:

```text
I confirm the stop was never lowered
```

but must be marked as `user_asserted`.

Canonical quality scoring for Stop Ratchet (binary; no partial credit):

```text
PASS → 100
FAIL → 0
```

UNKNOWN / NOT_APPLICABLE carry no numeric score, and compliance remains independent of the numerical quality score.

---

# 42. Post-Partial Breakeven Protection

After the required 50% partial is completed:

\[
EffectiveProtectiveStop
\ge
OriginalEntryBasis
\]

If stop is already above breakeven, no modification is required.

Canonical deadline:

```text
end of same regular session
```

Canonical quality scoring:

```text
At/above BE same session              100
At/above BE before next session        70
Raised but remains below BE            40
No meaningful risk reduction            0
```

Canonical compliance requires at/above BE by the configured deadline.

If stop history is unavailable:

```text
UNKNOWN
```

If partial rule never triggered:

```text
NOT_APPLICABLE
```

---

# 43. Trailing MA Selection

The trader chooses **SMA10 or SMA20** for the remaining position.

Neither is intrinsically preferred.

UI:

```text
Trailing MA

○ SMA10
○ SMA20
```

Store:

```text
trailing_ma_period = 10 | 20
trailing_ma_selected_at
trailing_ma_source
```

The selected MA must be authoritative for the trade.

## 43.1 No penalty for non-selected MA

Example:

```text
Selected trail: SMA20

Close < SMA10
Close > SMA20
```

Result:

```text
HOLD
No violation
```

SMA10 is irrelevant when SMA20 was selected.

Likewise, SMA20 is irrelevant if SMA10 was selected.

## 43.2 Anti-hindsight rule

Do not allow the trader to escape a signal by retrospectively changing:

```text
SMA10 → SMA20
```

after the SMA10 exit condition already occurred.

If selection is entered only during post-trade review, store provenance and timestamp honestly rather than pretending the choice was machine-observed before the trade.

---

# 44. Trailing MA Exit Signal

For selected SMA `n`:

\[
ExitSignal_t =
Close_t < SMA_n(t)
\]

Canonical:

```text
first completed daily close below selected MA
```

Equality does not trigger:

```text
Close > MA   HOLD
Close = MA   HOLD
Close < MA   EXIT SIGNAL
```

Store:

```text
signal_date
signal_close
signal_ma_value
actual_exit_time
actual_exit_price
```

Canonical execution policy:

```text
first 30 minutes of the next regular session
```

Configurable.

Suggested scoring:

```text
Exit within configured window        100
Later in same next session            70
One additional session late           40
Later / ignored signal                 0
```

Canonical compliance uses the configured execution window.

---

# 45. Protective Stop Supersedes MA Exit

If the remaining position is legitimately exited by a protective stop before a selected-MA close signal:

```text
Trailing MA criterion = NOT_APPLICABLE / SUPERSEDED
```

Do not penalize the trader for failing to wait for an MA close.

The protective stop and trailing MA serve different functions:

```text
protective stop = downside/catastrophic protection
selected MA     = winner trailing exit signal
```

---

# 46. Management Quality applicability

This dimension must distinguish conditional rules.

Example where +1R never occurs through Day 5:

```text
Partial Timing            NOT_APPLICABLE
Partial Sizing            NOT_APPLICABLE
Post-Partial BE           NOT_APPLICABLE

No Premature Reduction    applicable
Stop Ratchet              applicable
Trailing MA               applicable only if trailing phase is actually activated
```

Scores must be renormalized over applicable known criteria.

`NOT_APPLICABLE` must not be treated as missing coverage.

---

# 47. Setup/Entry/Management display

Trade Detail should show something similar to:

```text
SETUP QUALITY
A   91 / 100
Compliance: PASS
Coverage: 100%

ENTRY QUALITY
A   95 / 100
Compliance: PASS
Coverage: 100%

MANAGEMENT QUALITY
B   87 / 100
Compliance: FAIL
Coverage: 100%
```

Do not calculate:

```text
Overall Quality
```

---

# 48. Criterion drill-down

Each criterion should expose evidence.

Example:

```text
Range Contraction                    PASS

Prior 10 sessions
High                  $72.00
Low                   $60.00
Range                 $12.00

Recent 5 sessions
High                  $70.50
Low                   $64.00
Range                  $6.50

Ratio                  0.542
Compliance threshold   <=0.700
Quality score          90
```

Hybrid criterion example:

```text
Pivot

Detected                $70.65
Confirmed               $70.72
Source                  user_confirmed
Detection confidence    High
```

---

# 49. Evaluation workflow

## Step 1 — Select profile

```text
Quality Profile
Canonical BO v1
```

## Step 2 — Prepare evidence

TradeTally automatically:

- fetches market data
- detects Base Start
- detects Pivot
- computes machine-observable metrics
- inspects available trade/execution data
- determines which user inputs are still required

## Step 3 — Ask only for semantic inputs

Example:

```text
☐ Is this stock a leader?

Detected Base Start
Aug 18
[ Confirm ] [ Adjust ]

Detected Pivot
$70.72
[ Confirm ] [ Adjust ]

Entry Trigger
○ BO-PIVOT
○ BO-ORH-1
○ BO-ORH-5
○ BO-ORH-60

Trailing MA
○ SMA10
○ SMA20
```

## Step 4 — Evaluate

Persist immutable evaluation + evidence snapshot.

---

# 50. Profile Settings UI

Recommended location:

```text
Settings
└── Quality Profiles
```

Profile list:

```text
Canonical BO
Default Stock
Default Options
...
```

Profile editor:

```text
[ Setup ] [ Entry ] [ Management ]
```

Each criterion:

```text
Enabled
Required
Weight
Parameters
```

Weights within each dimension should normally sum to 100%.

---

# 51. Normal vs Advanced settings

Do not expose every detector implementation parameter in the primary UI.

## Normal

Examples:

```text
Prior Move minimum
Base duration
Range contraction threshold
Volume contraction threshold
Partial %
Partial day window
Minimum MFE
Stop width
Allowed trailing MA
```

## Advanced

Examples:

```text
Swing-low left/right windows
Swing-high left/right windows
Base detection horizon
Post-high base-start allowance
Pivot cluster tolerance
Pivot recent-touch window
Historical same-time reference length
Fallback detector behavior
```

All are configurable but should be organized for usability.

---

# 52. Profile save/version UX

Editing an existing profile version must not mutate it.

UI should clearly communicate:

```text
Saving these changes will create Canonical BO v2.
Existing evaluations remain linked to v1.
```

---

# 53. Historical re-evaluation

Trade Detail:

```text
Evaluated with: Canonical BO v1
Current version: Canonical BO v3

[ Evaluate with v3 ]
```

This creates a new evaluation.

Suggested history:

```text
Canonical BO v1   91 / 95 / 87
Canonical BO v3   88 / 93 / 90
```

The application may allow one evaluation to be marked as the primary display result, but should retain history.

---

# 54. Legacy Setup Quality compatibility

Current TradeTally uses legacy trade-level fields such as:

```text
quality_grade
quality_score
quality_metrics
```

Do not destructively remove existing behavior in the first migration.

Recommended transition:

1. Preserve legacy Stock/Options quality grading.
2. Present those as legacy/default profile behavior where useful.
3. New setup-specific evaluation records become authoritative for profile-based grading.
4. Optionally mirror new **Setup Quality** into legacy summary fields temporarily so existing trade lists/filters continue to work.
5. Do not attempt to squeeze Entry Quality and Management Quality into the old `quality_metrics` JSON structure.

Migration must preserve existing historical grades.

---

# 55. Service architecture

Do not place the full framework into one large `tradeQuality.service.js`.

Recommended logical organization:

```text
backend/src/services/quality/
├── profileService.js
├── evaluationService.js
├── marketEvidenceService.js
├── criterionRegistry.js
│
├── criteria/
│   ├── setup/
│   │   ├── leader.js
│   │   ├── priorMove.js
│   │   ├── baseDuration.js
│   │   ├── higherLows.js
│   │   ├── rangeContraction.js
│   │   ├── volumeContraction.js
│   │   ├── maTrend.js
│   │   └── pivotQuality.js
│   │
│   ├── entry/
│   │   ├── breakoutSession.js
│   │   ├── triggerCompliance.js
│   │   ├── volumePace.js
│   │   ├── rangePace.js
│   │   ├── extension.js
│   │   ├── initialStop.js
│   │   └── stopWidth.js
│   │
│   └── management/
│       ├── partialTiming.js
│       ├── partialSizing.js
│       ├── prematureReduction.js
│       ├── stopRatchet.js
│       ├── breakevenProtection.js
│       └── trailingMA.js
```

Exact file organization may adapt to existing conventions, but criteria must remain modular.

---

# 56. Standard criterion evaluator contract

Every criterion evaluator should receive normalized context, for example:

```text
trade
profileVersion
criterionConfig
confirmedContext
marketEvidence
executionEvidence
userInputs
```

and return a standardized result such as:

```json
{
  "key": "range_contraction",
  "status": "PASS",
  "score": 90,
  "scoring_value": 0.542,
  "compliance": true,
  "raw_value": 0.542,
  "evidence": {},
  "message": "Recent 5-session range is 54.2% of the prior 10-session range."
}
```

`scoring_value` is the normalized input to the criterion's immutable profile `scoring` envelope, used to derive (and later validate) the PASS/FAIL numerical `score`:

```text
binary             scoring_value unused; score derives from PASS/FAIL
step               finite numeric value on the configured curve
piecewise_linear   finite numeric value on the configured curve
discrete           configured outcome-key string
composite          object keyed by component.key with component inputs
                   (boolean for binary components, number for
                   step/piecewise components, string for discrete
                   components)
```

The persisted PASS/FAIL score must agree with the profile scoring configuration applied to `scoring_value`; caller-supplied scores are never trusted. UNKNOWN / NOT_APPLICABLE results carry no numeric `score` and no `scoring_value` is used.

Zero-weight enabled criteria (`weight = 0`, no `scoring` envelope) are compliance/evidence-only: they may return PASS/FAIL with `score: null`, contribute nothing to Quality score or coverage weight, and their status remains authoritative for Compliance when `required`. Positive-weight criteria always require a profile-derived PASS/FAIL score.

Allowed criterion status values:

```text
PASS
FAIL
NOT_APPLICABLE
UNKNOWN
```

---

# 57. Suggested API workflow

Exact REST naming may adapt to existing API conventions.

## Profiles

```text
GET    /api/quality-profiles
POST   /api/quality-profiles
GET    /api/quality-profiles/:id
GET    /api/quality-profiles/:id/versions
POST   /api/quality-profiles/:id/versions
```

## Evaluation preparation

```text
POST /api/trades/:tradeId/quality/prepare
```

Expected output includes:

```text
profile/version
detectedBaseStart
detectedPivot
detectionConfidence
requiredUserInputs
availableEvidence
unavailableEvidence
```

## Evaluation

```text
POST /api/trades/:tradeId/quality/evaluate
```

Input includes semantic confirmations/assertions only.

## Evaluation history

```text
GET /api/trades/:tradeId/quality/evaluations
```

---

# 58. Error and missing-data behavior

Never fabricate evidence.

## Intraday data unavailable

```text
Volume Pace = UNKNOWN
Range Pace = UNKNOWN
```

Do not replace with full-day volume/range when grading point-in-time Entry Quality.

## Stop history unavailable

```text
Stop Ratchet = UNKNOWN
Post-Partial BE = UNKNOWN
```

Do not infer from the final exit.

## Insufficient base sessions for configured windows

Example:

```text
Base duration = 12
Range criterion requires 15 sessions
```

Result:

```text
Range Contraction = UNKNOWN
```

Do not pull bars from before Base Start.

## Conditional criterion never activated

Example:

```text
MFE never reaches +1R through Day 5
```

Result:

```text
Partial Timing = NOT_APPLICABLE
```

not UNKNOWN and not FAIL.

---

# 59. Screenshots

TradeTally already supports trade images.

For v1:

```text
Screenshots remain supporting evidence for the user.
Do not build screenshot/CV/LLM grading into this feature.
```

The profile architecture should not prevent a future image-based criterion source, but it is explicitly out of scope now.

---

# 60. Stop-history capability audit

Before implementing automated Management Quality, inspect what TradeTally actually stores for:

```text
stop creation
stop modification
stop price
stop quantity
stop replacement
stop cancellation
timestamps
```

Do not assume full stop-order lifecycle data exist.

If only an initial stop or stop-loss field is available:

```text
Initial Stop criterion:
use actual available evidence where valid

Stop Ratchet:
UNKNOWN

Post-Partial BE:
UNKNOWN
```

until explicit stop-history support is implemented.

This capability gap must not block Setup Quality or the rest of Entry Quality.

---

# 61. Canonical BO default profile — concise configuration summary

## Setup

```text
Leader
  enabled                  true
  required                 true
  weight                   20
  source                   user assertion

Prior Move
  enabled                  true
  required                 true
  weight                   20
  minimum_pct              30
  search_lookback          60
  swing_left               3
  swing_right              3
  selection                most_recent_qualifying

Base Duration
  enabled                  true
  required                 true
  weight                   5
  minimum_sessions         10
  maximum_sessions         40
  detection_lookback       60
  swing_high_left          3
  swing_high_right         3
  max_post_high_advance    5%
  candidate_selection      earliest_qualifying

Higher Lows
  enabled                  true
  required                 true
  weight                   10
  swing_left               2
  swing_right              2
  minimum_lows             2
  tolerance                0.5%
  sequence_rule            no_material_lower_low

Range Contraction
  enabled                  true
  required                 true
  weight                   15
  recent_window            5
  prior_window             10
  maximum_ratio            0.70
  require_full_windows     true

Volume Contraction
  enabled                  true
  required                 true
  weight                   15
  recent_window            5
  prior_window             10
  maximum_ratio            0.70
  require_full_windows     true

MA Trend
  enabled                  true
  required                 true
  weight                   5
  type                     SMA
  fast_period              10
  slow_period              20
  slope_lookback           5
  support_period           20
  max_close_below_support  2%
  require_fast_above_slow  false

Pivot Quality
  enabled                  true
  required                 true
  weight                   10
  swing_left               2
  swing_right              2
  cluster_tolerance        2%
  minimum_touches          2
  recent_touch_window      10
  max_d1_distance          5%
  prior_close_tolerance    1%
  require_confirmation     true
```

---

# 62. Canonical BO default profile — Entry summary

```text
Breakout Session
  required                 true
  weight                   10

Trigger Compliance
  required                 true
  weight                   20
  allowed_types            BO-PIVOT, BO-ORH-1, BO-ORH-5, BO-ORH-60
  require_pivot_resolution true
  minimum_penetration      0%

Volume Pace
  required                 false
  weight                   10
  reference_sessions       20
  target                   1.40x

Range Pace
  required                 false
  weight                   5
  reference_sessions       20

Entry Extension
  required                 false
  weight                   20
  primary_normalization    ADR
  hard_maximum             disabled

Initial Stop
  required                 true
  weight                   20
  reference                observable LOD at stop establishment
  session                  regular
  minimum_buffer_method    minimum tick
  minimum_buffer_value     1 tick

Stop Width
  required                 true
  weight                   15
  volatility_method        ADR
  period                   20
  maximum_multiple         1.0
```

---

# 63. Canonical BO default profile — Management summary

```text
Partial Timing
  required_when_applicable true
  weight                   20
  earliest_day             3
  latest_day               5
  minimum_mfe              1.0R
  completion_window        same session

Partial Sizing
  required_when_applicable true
  weight                   15
  target                   50%

No Premature Reduction
  required                 true
  weight                   10

Stop Ratchet
  required                 true
  weight                   20
  downward_tolerance       0 ticks

Post-Partial BE
  required_when_applicable true
  weight                   15
  minimum_stop             original entry basis
  deadline                 same session

Trailing MA
  required_when_applicable true
  weight                   20
  allowed_periods          SMA10, SMA20
  trade_level_selection    required
  exit_signal              first daily close below selected MA
  equality_triggers        false
  execution_window         first 30 minutes next regular session
```

---

# 64. Acceptance criteria

The implementation is not complete until the following behaviors work.

## Profile behavior

- User can create multiple Quality Profiles.
- Profile criteria and thresholds are user-configurable.
- Editing a profile creates a new immutable version.
- Existing evaluations remain linked to their original version.
- Historical re-evaluation creates another evaluation instead of overwriting history.

## Setup evaluation

- User can mark Leader yes/no.
- TradeTally detects Base Start and allows Confirm/Adjust.
- TradeTally detects Pivot and allows Confirm/Adjust.
- Confirmed Base Start and Pivot become authoritative for downstream calculations.
- Prior Move is automatically derived.
- Base Duration is automatically derived.
- Higher Lows, Range Contraction, Volume Contraction, SMA Trend, and Pivot Quality are automatically evaluated.
- No technical metric requires manual entry.

## Entry evaluation

- TradeTally identifies the breakout session.
- Direct Pivot and configured ORH triggers are supported.
- ORH trigger cannot be valid before the opening range completes.
- ORH effective trigger is never below the confirmed Pivot.
- Entry extension is calculated automatically.
- Point-in-time volume/range evidence does not use later session data.
- Observable LOD is calculated only through stop establishment time.
- Later daily lows do not alter initial-stop compliance.
- Initial R remains immutable.
- Stop placement and stop width are separate criteria.

## Management evaluation

- Day 1 is initial-entry session.
- MFE in R is cumulative.
- If +1R occurs before Day 3, partial becomes due Day 3.
- If +1R first occurs Day 3–5, partial becomes due that session.
- If +1R never occurs by Day 5, partial criteria become NOT_APPLICABLE.
- 50% target is based on original position.
- Multiple fills can satisfy the target.
- Premature reductions are evaluated separately.
- Any actual downward stop ratchet fails the no-lowering rule.
- SMA10 and SMA20 are both valid trailing choices.
- A close below the non-selected MA does not create a violation.
- A valid protective-stop exit before the MA signal does not fail the MA criterion.

## Scoring/compliance

- Quality score and Compliance are independent.
- A required failure can produce `Quality A` and `Compliance FAIL`.
- Required UNKNOWN produces `Compliance INCOMPLETE` if no known required failure exists.
- NOT_APPLICABLE does not reduce coverage.
- UNKNOWN reduces coverage.
- Minimum coverage is configurable, canonical default 70%.
- No overall combined Setup/Entry/Management grade is calculated.

## Legacy safety

- Existing historical quality data is preserved.
- Existing TradeTally users without setup-specific profiles continue to function.
- Migration does not delete existing `quality_grade`, `quality_score`, or `quality_metrics`.
- Existing production data is not reset or recreated as part of this feature.

---

# 65. Explicit non-goals

Do not include in this implementation:

```text
ClickHouse integration
QuantSpace integration
New market-data provider integrations
True automated top-1–2% universe RS ranking
Screenshot AI/CV grading
Custom arbitrary code / strategy DSL
Outcome-dependent quality scoring
Automatic silent historical regrading
A single combined overall quality score
```

---

# 66. Recommended implementation sequence

Implement in controlled increments.

## Phase 1 — Foundation

```text
Quality Profile schema
Profile version schema
Trade Quality Evaluation schema
Generic criterion result contract
PASS / FAIL / NOT_APPLICABLE / UNKNOWN
Score / Compliance / Coverage aggregation
Canonical BO profile seed/default
```

## Phase 2 — Setup Quality

```text
Leader
Base Start detection + confirmation
Pivot detection + confirmation
Prior Move
Base Duration
Higher Lows
Range Contraction
Volume Contraction
SMA Trend
Pivot Quality
Setup Quality UI
```

## Phase 3 — Entry Quality

```text
Breakout Session
Trigger types
ORH calculation
Entry extension
Volume Pace
Range Pace
Observable LOD
Initial Stop
Initial R
Stop Width
Entry Quality UI
```

## Phase 4 — Management Quality

```text
Partial trigger
Partial timing
Partial sizing
Premature reduction
Stop history audit
Stop ratchet where evidence supports it
Post-partial BE where evidence supports it
SMA10/SMA20 selection
Trailing exit
Management Quality UI
```

## Phase 5 — Version/evaluation history

```text
Historical evaluation list
Evaluate using newer version
Primary evaluation selection
Comparison of versions
```

## Phase 6 — Legacy integration

```text
Legacy quality display compatibility
Trade list/filter compatibility
Backfill only where explicitly safe and intended
```

---

# 67. Implementation guidance

Do not attempt to implement this entire document as one undifferentiated service change.

Build the generic profile/evaluation framework first, then implement the Canonical BO criteria on top of it.

The implementation should remain extensible enough that future profiles such as:

```text
Episodic Pivot
Pullback
Mean Reversion
52-Week High Momentum
```

can reuse the same criterion framework without modifying the core grading engine.

The immediate target is not a generic strategy programming language. It is a structured, versioned, reusable grading framework with Canonical BO as the first complete profile.
