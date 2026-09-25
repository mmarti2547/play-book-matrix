"""Vegas math: moneyline <-> probability, vig removal, spread <-> win probability, EV, Kelly."""
import numpy as np
from scipy.stats import norm

from .config import MARGIN_SD


def american_to_decimal(ml):
    ml = np.asarray(ml, dtype=float)
    return np.where(ml > 0, 1 + ml / 100.0, 1 + 100.0 / np.abs(ml))


def implied_prob(ml):
    return 1.0 / american_to_decimal(ml)


def no_vig_home_prob(home_ml, away_ml):
    """Proportional vig removal: the book's hold is stripped so the two sides sum to 100%."""
    ph, pa = implied_prob(home_ml), implied_prob(away_ml)
    return ph / (ph + pa)


def hold(home_ml, away_ml):
    return implied_prob(home_ml) + implied_prob(away_ml) - 1.0


def spread_to_prob(expected_home_margin):
    """How oddsmakers relate a spread to win probability: final margin ~ Normal(spread, 13.45)."""
    return norm.cdf(np.asarray(expected_home_margin, dtype=float) / MARGIN_SD)


def cover_prob(model_margin, spread_line):
    """P(home covers) where spread_line is the expected home margin (nflverse sign convention)."""
    return norm.cdf((np.asarray(model_margin, float) - np.asarray(spread_line, float)) / MARGIN_SD)


def ev_per_dollar(p, ml):
    return p * (american_to_decimal(ml) - 1.0) - (1.0 - p)


def kelly_fraction(p, ml, scale=0.25):
    b = american_to_decimal(ml) - 1.0
    f = (b * p - (1.0 - p)) / b
    return np.clip(f * scale, 0.0, 0.05)
