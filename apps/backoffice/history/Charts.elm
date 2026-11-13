module Charts exposing (Day, bars, cumulative, split)

import Html exposing (Html, div, p, span, text)
import Html.Attributes as H
import Lingo.Date as Date
import Lingo.Lang exposing (Lang(..))
import Lingo.Theme exposing (Theme)
import Svg exposing (circle, g, polygon, polyline, svg)
import Svg.Attributes as S


type alias Day =
    { date : String, seconds : Float, regular : Float, shorts : Float }


number : Float -> String
number value =
    String.fromFloat (toFloat (round (value * 10)) / 10)


ticks : List Day -> Html msg
ticks days =
    let
        count =
            max 1 (List.length days)
    in
    div [ H.class "x-axis" ]
        (List.indexedMap
            (\i day ->
                if List.member i (List.map (\n -> (count - 1) * n // 4) [ 0, 1, 2, 3, 4 ]) then
                    span
                        [ H.style "position" "absolute"
                        , H.style "left" (String.fromFloat ((toFloat i + 0.5) / toFloat count * 100) ++ "%")
                        , H.style "transform"
                            (if i == 0 then
                                "none"

                             else if i == count - 1 then
                                "translateX(-100%)"

                             else
                                "translateX(-50%)"
                            )
                        ]
                        [ text (Date.short day.date) ]

                else
                    text ""
            )
            days
        )


bars : Theme -> List Day -> Html msg
bars theme days =
    let
        maximum =
            List.map (.seconds >> (\s -> s / 60)) days |> List.maximum |> Maybe.withDefault 0

        step =
            if maximum > 120 then
                30

            else if maximum > 10 then
                5

            else
                1

        top =
            max 1 (toFloat (ceiling (maximum / step)) * step)

        band color seconds =
            div
                [ H.style "height" (String.fromFloat (seconds / 60 / top * 100) ++ "%")
                , H.style "min-height"
                    (if seconds > 0 then
                        "1px"

                     else
                        "0"
                    )
                , H.style "background" color
                ]
                []
    in
    div [ H.class "stacked-chart" ]
        [ div [ H.class "y-axis" ] (List.map (\n -> span [] [ text (number (top * n / 4)) ]) [ 4, 3, 2, 1, 0 ])
        , div [ H.class "plot-column" ]
            [ div [ H.class "bar-track", H.attribute "role" "img", H.attribute "aria-label" "Recorded watch minutes per day, split into videos and Shorts" ]
                (List.map (\n -> div [ H.class "gridline", H.style "top" (String.fromInt (n * 25) ++ "%") ] []) [ 0, 1, 2, 3, 4 ]
                    ++ [ div [ H.class "bars" ]
                            (List.map
                                (\day ->
                                    div
                                        [ H.class "day-bar"
                                        , H.attribute "data-date" day.date
                                        , H.attribute "data-state"
                                            (if day.seconds > 0 then
                                                "recorded"

                                             else
                                                "empty"
                                            )
                                        , H.title (day.date ++ " · videos " ++ number (day.regular / 60) ++ " min · Shorts " ++ number (day.shorts / 60) ++ " min")
                                        ]
                                        [ band (theme.fill De) day.regular, band (theme.fill Bcs) day.shorts ]
                                )
                                days
                            )
                       ]
                )
            , ticks days
            ]
        ]


cumulative : Theme -> List Day -> Html msg
cumulative theme days =
    let
        total =
            List.map .seconds days |> List.sum |> max 1

        count =
            max 1 (List.length days)

        ( _, points ) =
            List.foldl
                (\( i, day ) ( sum, acc ) ->
                    let
                        next =
                            sum + day.seconds
                    in
                    ( next, acc ++ [ String.fromFloat ((toFloat i + 1) / toFloat count * 1000) ++ "," ++ String.fromFloat (168 - next / total * 156) ] )
                )
                ( 0, [ "0,168" ] )
                (List.indexedMap Tuple.pair days)

        line =
            String.join " " points
    in
    div [ H.class "cumulative-chart" ]
        [ p [ H.class "micro muted chart-note" ] [ text "Running total within the selected range · elapsed watch time" ]
        , svg [ S.viewBox "0 0 1000 180", S.preserveAspectRatio "none", H.attribute "role" "img", H.attribute "aria-label" "Cumulative recorded watch time" ]
            [ polygon [ S.points (line ++ " 1000,180 0,180"), S.fill (theme.fill De), S.opacity "0.12" ] []
            , polyline [ S.points line, S.fill "none", S.stroke (theme.fill De), S.strokeWidth "2.5", H.attribute "vector-effect" "non-scaling-stroke" ] []
            ]
        , ticks days
        ]


split : Theme -> Float -> Float -> Html msg
split theme regular shorts =
    let
        total =
            regular + shorts

        share seconds =
            if total > 0 then
                seconds / total

            else
                0

        circumference =
            2 * pi * 52

        arc seconds offset color =
            circle [ S.cx "62", S.cy "62", S.r "52", S.fill "none", S.stroke color, S.strokeWidth "13", S.strokeDasharray (String.fromFloat (max 0 (share seconds * circumference - 3)) ++ " " ++ String.fromFloat (circumference - max 0 (share seconds * circumference - 3))), S.strokeDashoffset (String.fromFloat (-offset * circumference)) ] []

        legend caption seconds color =
            div [ H.class "format-legend-row" ]
                [ span [ H.class "dot", H.style "background" color ] []
                , span [] [ text caption ]
                , span [ H.class "figure" ]
                    [ text
                        (if total > 0 then
                            String.fromInt (round (share seconds * 100)) ++ "%"

                         else
                            "—"
                        )
                    ]
                , span [ H.class "micro muted" ] [ text (number (seconds / 60) ++ " min") ]
                ]
    in
    div [ H.class "donut-layout" ]
        [ div [ H.class "donut" ]
            [ svg [ S.viewBox "0 0 124 124", H.attribute "role" "img", H.attribute "aria-label" "Watch time split between regular videos and Shorts" ]
                [ circle [ S.cx "62", S.cy "62", S.r "52", S.fill "none", S.stroke theme.hairline, S.strokeWidth "13" ] []
                , g [ S.transform "rotate(-90 62 62)" ] [ arc regular 0 (theme.fill De), arc shorts (share regular) (theme.fill Bcs) ]
                ]
            , div [ H.class "ring-center" ] [ span [ H.class "figure" ] [ text (number (total / 60)) ], span [ H.class "micro muted" ] [ text "minutes" ] ]
            ]
        , div [ H.class "donut-legend" ] [ legend "Videos" regular (theme.fill De), legend "Shorts" shorts (theme.fill Bcs) ]
        ]
