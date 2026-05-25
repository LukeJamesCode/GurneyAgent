// Debounced GPIO button poller. Emits state-sync frames to the server on
// volume/mute changes and dispatches local mute behaviour immediately so
// the user feels the response without a server round-trip.

#pragma once

int gs_buttons_start(void);
