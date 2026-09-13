# DUDG Bugs

## join lobby via Ethernal Panel (Socials Menu -> "Beitreten")

Client receives host-like view, but misses data like lobby code, Connection state is displayed as "Keine "Lobby".

Once the player joined the lobby via code, then leaves it and rejoins via Ethernal Panel, it works as intended, meaning the two join methods are not initializing the player in the lobby the same way.

Maybe check on event triggered by using "Beitreten" button on the player, how is it handled on playerclient/game server side?

## tables for Rangliste and Rundenergebnis are not fully shown on smartphones with increased font/element size configured in OS

The tables are pretty static and when the size of the font increases, the content of the table moves out of the field of view on the weg page, exceeding the limits of the card the tables are part of.

If this happens, the tables need to support scrolling so I can scroll to the right.
