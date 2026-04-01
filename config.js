const config = {
  // Array of group IDs to monitor
  targetGroups: [
  "120363404381195314@g.us",
  "120363422106306738@g.us",
  "120363402751263426@g.us",
  "120363404137375214@g.us",
  "120363420630870209@g.us",
  "120363423354985049@g.us",
  "120363423865787553@g.us",
  "120363423239489272@g.us",
  "120363405779297224@g.us",
  "120363421817761550@g.us",
  "120363405661436003@g.us",
  "120363421453326864@g.us",
  "120363419698566782@g.us",
  "120363406806117593@g.us",
  "120363423570761273@g.us",
  "120363419023224008@g.us",
  "120363403836966768@g.us",
  "120363402786873072@g.us",
  "120363423527541640@g.us",
  "120363421946113590@g.us",
  "120363425110657096@g.us",
  "120363405365981521@g.us",
  "120363422778164308@g.us",
  "120363423445319054@g.us",
  "120363402659731948@g.us",
  "120363403424216566@g.us",
  "120363401227194595@g.us",
  "120363419512489267@g.us",
  "120363420833285456@g.us",
  "120363406648533850@g.us",
  "120363404593142383@g.us",
  "120363401931675519@g.us"
],

  // Sender sessions — each one is a separate WhatsApp login (burner account)
  // Add or remove names here. Each will get its own QR code on the dashboard.
  senderSessions: ['sender-1', 'sender-2'],

  // The message to send to the extracted numbers
  messageToSend: `*Stop wasting time typing replies* .

AIReply lets you: • Get 50 free AI replies on signup

- Paste multiple post links at once
- Choose a reply tone (casual, smart, funny, etc.)
- Auto-generate comments for each post
- Post replies automatically with one click
If you're active on twitter, this saves you hours.

👉  *https://aireply.onrender.com* 

 *Join this group to access other tools* 

https://chat.whatsapp.com/JIbysvs6zGw5TU9ecbQujh?mode=gi_t`,

  // Random delay between messages (in milliseconds)
  // 5 minutes = 300000, 10 minutes = 600000
  minDelay: 300000,
  maxDelay: 600000
};

module.exports = { config };
