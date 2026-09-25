"""Static reference data for Play Book Matrix: stadium coordinates, roofs, team homes."""

# stadium_id (nflverse) -> (name, lat, lon, roof_type)
# roof_type: "open", "dome", "retractable", "canopy" (canopy = fixed translucent roof, plays indoor)
STADIUMS = {
    "ATL97": ("Mercedes-Benz Stadium", 33.7554, -84.4008, "retractable"),
    "BAL00": ("M&T Bank Stadium", 39.2780, -76.6227, "open"),
    "BOS00": ("Gillette Stadium", 42.0909, -71.2643, "open"),
    "BUF00": ("Highmark Stadium", 42.7738, -78.7870, "open"),
    "CAR00": ("Bank of America Stadium", 35.2258, -80.8528, "open"),
    "CHI98": ("Soldier Field", 41.8623, -87.6167, "open"),
    "CIN00": ("Paycor Stadium", 39.0955, -84.5160, "open"),
    "CLE00": ("Huntington Bank Field", 41.5061, -81.6995, "open"),
    "DAL00": ("AT&T Stadium", 32.7473, -97.0945, "retractable"),
    "DEN00": ("Empower Field at Mile High", 39.7439, -105.0201, "open"),
    "DET00": ("Ford Field", 42.3400, -83.0456, "dome"),
    "GNB00": ("Lambeau Field", 44.5013, -88.0622, "open"),
    "HOU00": ("NRG Stadium", 29.6847, -95.4107, "retractable"),
    "IND00": ("Lucas Oil Stadium", 39.7601, -86.1639, "retractable"),
    "JAX00": ("EverBank Stadium", 30.3239, -81.6373, "open"),
    "KAN00": ("GEHA Field at Arrowhead Stadium", 39.0489, -94.4839, "open"),
    "LAX01": ("SoFi Stadium", 33.9535, -118.3392, "canopy"),
    "MIA00": ("Hard Rock Stadium", 25.9580, -80.2389, "open"),
    "MIN01": ("U.S. Bank Stadium", 44.9737, -93.2577, "dome"),
    "NAS00": ("Nissan Stadium", 36.1665, -86.7713, "open"),
    "NOR00": ("Caesars Superdome", 29.9511, -90.0812, "dome"),
    "NYC01": ("MetLife Stadium", 40.8135, -74.0745, "open"),
    "PHI00": ("Lincoln Financial Field", 39.9008, -75.1675, "open"),
    "PHO00": ("State Farm Stadium", 33.5276, -112.2626, "retractable"),
    "PIT00": ("Acrisure Stadium", 40.4468, -80.0158, "open"),
    "SEA00": ("Lumen Field", 47.5952, -122.3316, "open"),
    "SFO01": ("Levi's Stadium", 37.4030, -121.9700, "open"),
    "TAM00": ("Raymond James Stadium", 27.9759, -82.5033, "open"),
    "VEG00": ("Allegiant Stadium", 36.0909, -115.1833, "dome"),
    "WAS00": ("Northwest Stadium", 38.9076, -76.8645, "open"),
    # International / neutral sites
    "LON00": ("Wembley Stadium", 51.5560, -0.2795, "open"),
    "LON01": ("Twickenham Stadium", 51.4560, -0.3415, "open"),
    "LON02": ("Tottenham Hotspur Stadium", 51.6043, -0.0664, "open"),
    "MEX00": ("Estadio Azteca", 19.3029, -99.1505, "open"),
    "MUN01": ("Allianz Arena", 48.2188, 11.6247, "open"),
    "FRA00": ("Deutsche Bank Park", 50.0686, 8.6455, "open"),
    "BER00": ("Olympiastadion Berlin", 52.5147, 13.2395, "open"),
    "PAR00": ("Stade de France", 48.9245, 2.3601, "open"),
    "MAD01": ("Santiago Bernabeu", 40.4531, -3.6883, "retractable"),
    "SAO00": ("Neo Quimica Arena", -23.5453, -46.4742, "open"),
    "RIO00": ("Maracana Stadium", -22.9122, -43.2302, "open"),
    "MEL00": ("Melbourne Cricket Ground", -37.8200, 144.9834, "open"),
    "DUB00": ("Croke Park", 53.3607, -6.2511, "open"),
    # Legacy homes (only used for travel distance in historical seasons)
    "ATL00": ("Georgia Dome", 33.7577, -84.4008, "dome"),
    "OAK00": ("Oakland Coliseum", 37.7516, -122.2005, "open"),
    "SDG00": ("Qualcomm Stadium", 32.7831, -117.1196, "open"),
    "STL00": ("Edward Jones Dome", 38.6328, -90.1885, "dome"),
    "LAX97": ("LA Memorial Coliseum", 34.0141, -118.2879, "open"),
    "LAX99": ("Dignity Health Sports Park", 33.8644, -118.2611, "open"),
    "MIN98": ("TCF Bank Stadium", 44.9765, -93.2246, "open"),
    "MIN00": ("Metrodome", 44.9738, -93.2581, "dome"),
    "CHI99": ("Soldier Field", 41.8623, -87.6167, "open"),
}

# Current home stadium for each team (travel distance baseline)
TEAM_HOME = {
    "ARI": "PHO00", "ATL": "ATL97", "BAL": "BAL00", "BUF": "BUF00", "CAR": "CAR00",
    "CHI": "CHI98", "CIN": "CIN00", "CLE": "CLE00", "DAL": "DAL00", "DEN": "DEN00",
    "DET": "DET00", "GB": "GNB00", "HOU": "HOU00", "IND": "IND00", "JAX": "JAX00",
    "KC": "KAN00", "LA": "LAX01", "LAC": "LAX01", "LV": "VEG00", "MIA": "MIA00",
    "MIN": "MIN01", "NE": "BOS00", "NO": "NOR00", "NYG": "NYC01", "NYJ": "NYC01",
    "PHI": "PHI00", "PIT": "PIT00", "SEA": "SEA00", "SF": "SFO01", "TB": "TAM00",
    "TEN": "NAS00", "WAS": "WAS00",
    # legacy abbreviations
    "OAK": "OAK00", "SD": "SDG00", "STL": "STL00",
}

# Injury report position -> roster unit used for cluster scoring
UNIT_OF_POSITION = {
    "QB": "qb",
    "T": "ol", "G": "ol", "C": "ol", "OT": "ol", "OG": "ol", "OL": "ol",
    "WR": "skill", "TE": "skill", "RB": "skill", "FB": "skill", "HB": "skill",
    "DE": "front", "DT": "front", "NT": "front", "DL": "front", "LB": "front",
    "OLB": "front", "ILB": "front", "MLB": "front", "EDGE": "front",
    "CB": "db", "S": "db", "FS": "db", "SS": "db", "DB": "db",
}

# Probability-weighted absence by final report designation
STATUS_WEIGHT = {"Out": 1.0, "Doubtful": 0.85, "Questionable": 0.25}

# NFL Pythagorean exponent (Football Outsiders / Morey fit)
PYTHAG_EXP = 2.37

# Historical std-dev of NFL final margins around the spread (points)
MARGIN_SD = 13.45

MODEL_VERSION = "pbm-1.0"
