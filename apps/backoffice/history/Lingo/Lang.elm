module Lingo.Lang exposing (Lang(..), all, code, label, name, normalise)

import Char


type Lang
    = De
    | En
    | Bcs
    | Es
    | Other


all : List Lang
all =
    [ De, En, Bcs, Es, Other ]


normalise : String -> Lang
normalise raw =
    let
        parts =
            String.split "-" (String.toLower raw)

        valid part =
            not (String.isEmpty part) && String.length part <= 8 && String.all (\c -> Char.isAlphaNum c && Char.toCode c < 128) part
    in
    if not (List.all valid parts) then
        Other

    else
        case List.head parts of
            Just "de" ->
                De

            Just "en" ->
                En

            Just "es" ->
                Es

            Just "sr" ->
                Bcs

            Just "hr" ->
                Bcs

            Just "bs" ->
                Bcs

            Just "sh" ->
                Bcs

            Just "bcs" ->
                Bcs

            _ ->
                Other


code : Lang -> String
code lang =
    case lang of
        De ->
            "de"

        En ->
            "en"

        Bcs ->
            "bcs"

        Es ->
            "es"

        Other ->
            "other"


label : Lang -> String
label lang =
    if lang == Other then
        "Other"

    else
        String.toUpper (code lang)


name : Lang -> String
name lang =
    case lang of
        De ->
            "German"

        En ->
            "English"

        Bcs ->
            "Bosnian / Croatian / Serbian"

        Es ->
            "Spanish"

        Other ->
            "Other languages"
