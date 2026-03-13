"""Quick sanity-check for noise and event filters."""
import sys
sys.path.insert(0, "src")
from fetch_news import is_noise, high_value_match_crypto, high_value_match_macro  # noqa

SHOULD_SKIP = [
    "Massive $1.8 Billion Sell-Off Drives Bitcoin Bear Market",
    "Bitcoin Soars: Remarkable Rally Propels BTC Above $65,000",
    "Ethereum Technical Analysis February 28: Support Resistance Levels",
    "Bitcoin price prediction: BTC could reach $100k by year end",
    "BTC drops 12% amid US tensions",
    "Altcoins crumble as ETH leads losses",
    "Crypto market correction: buy the dip?",
]

SHOULD_ALERT = [
    "Security breach at Arbitrum: $180M drained from bridge contract",
    "SEC files charges against Binance CEO for illegal securities offering",
    "Ethereum exchange halted: withdrawals suspended amid insolvency fears",
    "Flash loan attack drains $50M from DeFi protocol",
    "US government seizes 50,000 BTC from Silk Road hacker",
    "NATO invokes Article 5 following coordinated cyberattack on EU banks",
    "Federal Reserve Chair resigns amid internal conflict over crypto policy",
    "Stablecoin USDC depegs to 0.87 after Circle bank partner collapses",
    "India announces total crypto ban effective immediately",
    "Mt Gox creditors file lawsuit seeking 10B in damages",
]

print("=== SHOULD BE SKIPPED ===")
for h in SHOULD_SKIP:
    n = is_noise(h)
    status = "SKIP" if n else "BUG - passed through!"
    print(f"  [{status:<22}] {h[:70]}")

print()
print("=== SHOULD ALERT ===")
for h in SHOULD_ALERT:
    n = is_noise(h)
    cat = high_value_match_crypto(h) or high_value_match_macro(h)
    if n:
        status = "BUG - blocked!"
    elif cat:
        status = cat
    else:
        status = "no category (needs strong sentiment)"
    print(f"  [{status:<28}] {h[:65]}")
