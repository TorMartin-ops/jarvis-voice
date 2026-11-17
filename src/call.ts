/**
 * Decide how to bring a Discord user into the voice channel the bot is in.
 *
 * Discord gives bots no way to ring someone. The options are:
 *  - move: the user is already in a voice channel and the bot has MOVE_MEMBERS.
 *  - dm:   otherwise, send the user a direct message with a link to the channel.
 */
export type CallPlan =
  | { kind: "move"; fromChannelId: string }
  | { kind: "dm" }
  | { kind: "none"; reason: string };

export function planCall(input: {
  userVoiceChannelId: string | null;
  targetChannelId: string;
  botCanMoveMembers: boolean;
}): CallPlan {
  if (input.userVoiceChannelId === input.targetChannelId) {
    return { kind: "none", reason: "The user is already in that voice channel." };
  }
  if (input.userVoiceChannelId && input.botCanMoveMembers) {
    return { kind: "move", fromChannelId: input.userVoiceChannelId };
  }
  return { kind: "dm" };
}

/** The message sent to a user the bot cannot move. Plain text, no mentions. */
export function inviteText(opts: {
  callerName: string;
  channelName: string;
  guildId: string;
  channelId: string;
}): string {
  return (
    `${opts.callerName} vil at du blir med i stemmekanalen "${opts.channelName}" for en samtale. ` +
    `Lenke: https://discord.com/channels/${opts.guildId}/${opts.channelId}`
  );
}
