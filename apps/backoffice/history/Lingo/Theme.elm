module Lingo.Theme exposing (Theme, dark, light, variables)

import Html exposing (Attribute)
import Html.Attributes exposing (attribute)
import Lingo.Lang exposing (Lang(..))


type alias Theme =
    { ground : String
    , surface : String
    , surfaceLift : String
    , hairline : String
    , gridline : String
    , axis : String
    , textPrimary : String
    , textSecondary : String
    , textTertiary : String
    , fill : Lang -> String
    , label : Lang -> String
    , glow : Float
    }


dark : Theme
dark =
    { ground = "#0F1115"
    , surface = "#161A22"
    , surfaceLift = "#1A1F29"
    , hairline = "rgba(255,255,255,0.07)"
    , gridline = "rgba(255,255,255,0.12)"
    , axis = "rgba(255,255,255,0.18)"
    , textPrimary = "#EEF2F7"
    , textSecondary = "#9BA6B5"
    , textTertiary = "#7F8B9B"
    , fill =
        \lang ->
            case lang of
                De ->
                    "#FF7A5E"

                En ->
                    "#4AA8E8"

                Bcs ->
                    "#6EE7B7"

                Es ->
                    "#F5C04E"

                Other ->
                    "#9D7BF5"
    , label =
        \lang ->
            case lang of
                De ->
                    "#FF9B86"

                En ->
                    "#7CC4F5"

                Bcs ->
                    "#6EE7B7"

                Es ->
                    "#F5C04E"

                Other ->
                    "#BEA6FF"
    , glow = 1
    }


light : Theme
light =
    { ground = "#FBFBFD"
    , surface = "#FFFFFF"
    , surfaceLift = "#FFF6F3"
    , hairline = "rgba(15,17,21,0.09)"
    , gridline = "rgba(15,17,21,0.10)"
    , axis = "rgba(15,17,21,0.18)"
    , textPrimary = "#14171D"
    , textSecondary = "#5A6472"
    , textTertiary = "#717B89"
    , fill =
        \lang ->
            case lang of
                De ->
                    "#E85C3A"

                En ->
                    "#2B8FD6"

                Bcs ->
                    "#15A378"

                Es ->
                    "#E0A313"

                Other ->
                    "#8861D5"
    , label =
        \lang ->
            case lang of
                De ->
                    "#BE3C1B"

                En ->
                    "#17699E"

                Bcs ->
                    "#0C7554"

                Es ->
                    "#845900"

                Other ->
                    "#6940AD"
    , glow = 0.55
    }


variables : Theme -> Lang -> List (Attribute msg)
variables theme target =
    [ attribute "style"
        (String.join ";"
            (List.map (\( key, value ) -> key ++ ":" ++ value)
                [ ( "--ground", theme.ground )
                , ( "--surface", theme.surface )
                , ( "--lift", theme.surfaceLift )
                , ( "--hairline", theme.hairline )
                , ( "--gridline", theme.gridline )
                , ( "--axis", theme.axis )
                , ( "--text", theme.textPrimary )
                , ( "--muted", theme.textSecondary )
                , ( "--tertiary", theme.textTertiary )
                , ( "--accent", theme.fill target )
                , ( "--accent-label", theme.label target )
                , ( "--glow", String.fromFloat (0.16 * theme.glow) )
                ]
            )
        )
    ]
