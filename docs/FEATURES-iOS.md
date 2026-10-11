# eve feature map: iOS app only

These rows are reachable only from the native iOS app. The work is the deferred epic barelyworkingcode/relayClient#3; eve's checks (`check:coverage`, the map rules) do not count them.

| ID | Action | Simple door | Power door | Screen proof | Relay proof | Refusals | Journey | Spec |
|---|---|---|---|---|---|---|---|---|
| G9.22 | Change the river sound volume in the iOS app | iOS app > Voice view > slider "River volume" | none | The value beside the slider changes; the row shows only in the native app | none | none | none yet | none yet: iOS app only (relayClient#3) |
| G9.23 | Stream the phone's audio log to the server | iOS app > Voice view > checkbox "Stream device logs" | none | The box is ticked or cleared; the row shows only in the native app | none | none | none yet | none yet: iOS app only (relayClient#3) |
| G9.25 | Fall back to the server engines after a voice model crash | n/a: background | n/a: background | After a relaunch the speech engine is "server" again, as the line "TTS: server  ·  STT: server" shows | none | none | none yet | none yet: iOS app only (relayClient#3) |
| G15.1.r3 | Refusal r3 of G15.1: sign-in fails in the iOS app | iOS app > Sign-in screen > button "Sign In" > button "Sign In with Passkey" | none | none | none | r3: in the app: text "Authentication failed. Please try again." | none | none yet: iOS app only (relayClient#3) |
| G15.5 | Choose where speech is made in the iOS app | iOS app > Rail > button "Settings" > combobox "Speech engine" (iOS only: needs a test-machine pass) | none | combobox "Speech engine" offers "On this device" and "Server"; shown only in the iOS app | none | none | none yet | none yet: iOS app only (relayClient#3) |
| G15.6 | Choose where dictation is made in the iOS app | iOS app > Rail > button "Settings" > combobox "Dictation engine" (iOS only: needs a test-machine pass) | none | combobox "Dictation engine" offers "On this device" and "Server"; shown only in the iOS app | none | none | none yet | none yet: iOS app only (relayClient#3) |
| G15.7 | Keep a voice conversation running with the screen locked | iOS app > Voice view | none | text "Listening..." shows in Voice view; the conversation goes on after the screen locks | none | none | none yet | none yet: iOS app only (relayClient#3) |
| G15.8 | Feel a tap when switching voice input mode or holding the mic | iOS app > Voice view > hold the mic | none | button "Hold to record" shows as recording and text "Listening..." shows | none | none | none yet | none yet: iOS app only (relayClient#3) |
