# Rebuilds Gecko's checked-in ICU data file (config/external/icu/data/icudt*.dat)
# with the filter in intl/icu/data_filter.json, using the step of
# intl/update-icu.sh that does it (intl/icu_sources_data.py's
# update_data_file): ICU is configured and built for the host, and its data
# build tool writes the archive.
#
# gecko.patch adds a locale filter for English and Japanese, FireDog's UI
# locales. The data is embedded in the program, and the other locales' display
# names (of languages, scripts, regions, currencies, units and time zones) are
# about 10 MB of it. Mozilla's filter keeps every locale's main data
# (locales_tree), so dates and numbers are still formatted in every locale;
# only those names fall back to the root locale's.
#
# Run with `./mach python` from the Gecko source directory. A stamp next to the
# data file records the filter it was built with, so a rerun with the same
# filter does nothing.
import hashlib
import os
import sys

topsrcdir = os.getcwd()
sys.path.insert(0, os.path.join(topsrcdir, "intl"))
import icu_sources_data  # noqa: E402

with open(os.path.join(topsrcdir, "intl/icu/data_filter.json"), "rb") as f:
    digest = hashlib.sha256(f.read()).hexdigest()
stamp = os.path.join(topsrcdir, "config/external/icu/data/data_filter.sha256")
if os.path.exists(stamp) and open(stamp).read().strip() == digest:
    print("ICU data is up to date with intl/icu/data_filter.json")
    sys.exit(0)
if not icu_sources_data.update_data_file(topsrcdir):
    sys.exit(1)
with open(stamp, "w") as f:
    f.write(digest + "\n")
