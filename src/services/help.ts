import { EmbedBuilder } from 'discord.js';
import type { ColorResolvable } from 'discord.js';

import { command } from '$services/command.js';
import type Command from '$services/command';

export default function helpCommand(
  title: string,
  prefix: string,
  color: ColorResolvable,
  manual: Command[]
) {
  return command(
    {
      name: 'help',
      aliases: ['h'],
      desc: 'Shows help for a/all command(s)',
      args: [
        {
          name: 'command',
          type: 'string[]',
          desc: 'The command to show help for',
          optional: true
        }
      ] as const
    },
    async ({ channel }, [args]) => {
      if (!args)
        return channel.send({
          embeds: [
            new EmbedBuilder()
              .setTitle(`${title} Commands`)
              .setDescription(
                manual
                  .map(({ name, aliases }) =>
                    [name, ...(aliases?.map(alias => alias) || [])].join('|')
                  )
                  .join(', ')
              )
              .setColor(color)
          ]
        });

      let commandManual: Command | undefined;
      let commandManuals = manual as readonly Command[];
      const usage: string[] = [];
      const commands = args.map(arg => arg.toLowerCase());
      for (const command of commands) {
        commandManual = commandManuals.find(
          ({ name, aliases }) => name === command || aliases?.includes(command)
        );
        if (!commandManual) {
          commandManual = undefined;
          break;
        }
        commandManuals = commandManual.subcommands || [];
        usage.push(
          [commandManual.name, ...(commandManual.aliases || [])].join('/')
        );
      }
      if (commandManual)
        usage.push(
          ...commandManual.args.map(
            ({ name, type, optional, default: def }) =>
              `<${name}${optional || type === 'bool' ? '?' : ''}:${type}${
                def !== undefined ? `=${def}` : ''
              }>`
          )
        );
      else
        return channel.send(
          `No help found for command \`${commands.join(' ')}\``
        );

      const embed = new EmbedBuilder()
        .setTitle(`${title} Help: ${commands.join(' ')}`)
        .setDescription(commandManual.desc)
        .setColor(color)
        .addFields({ name: 'Usage', value: `\`${prefix}${usage.join(' ')}\`` });
      if (commandManual.subcommands)
        embed.addFields({
          name: 'Subcommands',
          value: commandManual.subcommands
            .map(({ name }) => `\`${name}\``)
            .join(', ')
        });
      return channel.send({ embeds: [embed] });
    }
  );
}
