module Evidence exposing (view)

import Html exposing (..)
import Html.Attributes exposing (attribute, class, href, id, rel, target, type_)
import Html.Events exposing (on, onClick)
import Json.Decode as D
import Json.Encode as E
import Url


field : String -> D.Value -> String
field key value =
    D.decodeValue (D.field key D.string) value |> Result.withDefault ""


object : String -> D.Value -> D.Value
object key value =
    D.decodeValue (D.field key D.value) value |> Result.withDefault E.null


items : String -> D.Value -> List D.Value
items key value =
    D.decodeValue (D.field key (D.list D.value)) value |> Result.withDefault []


fallback : String -> String
fallback value =
    if String.isEmpty value then
        "Not recorded"

    else
        value


fact : String -> String -> Html msg
fact label value =
    div [ class "evidence-fact" ] [ dt [ class "eyebrow" ] [ text label ], dd [] [ text (fallback value) ] ]


view : (Float -> String) -> msg -> Maybe D.Value -> Html msg
view formatDuration close selected =
    node "dialog"
        [ id "evidence-dialog", class "evidence-dialog", attribute "aria-labelledby" "evidence-heading", on "evidence-dismiss" (D.succeed close) ]
        (case selected of
            Nothing ->
                []

            Just video ->
                let
                    evidence =
                        object "evidence" video

                    detector =
                        object "text" evidence

                    captions =
                        items "captions" evidence

                    savedTitle =
                        field "title" evidence

                    videoTitle =
                        if savedTitle == "" then
                            fallback (field "title" video)

                        else
                            savedTitle

                    truncated =
                        D.decodeValue (D.field "descriptionTruncated" D.bool) evidence |> Result.withDefault False
                in
                [ div [ class "evidence-header" ]
                    [ div [] [ p [ class "eyebrow" ] [ text "Behind the record" ], h2 [ id "evidence-heading" ] [ text "Video evidence" ] ]
                    , button [ class "evidence-close", type_ "button", onClick close, attribute "aria-label" "Close evidence", attribute "autofocus" "" ] [ text "✕" ]
                    ]
                , div [ class "evidence-body" ]
                    [ section [ class "evidence-hero" ]
                        [ p [ class "eyebrow" ] [ text (field "person" video ++ " · " ++ field "lastWatchedLabel" video) ]
                        , h3 [] [ text videoTitle ]
                        , p [ class "muted" ] [ text (fallback (field "channel" video)) ]
                        , a [ class "evidence-youtube", href ("https://www.youtube.com/watch?v=" ++ Url.percentEncode (field "videoId" video)), target "_blank", rel "noreferrer" ] [ text "Open on YouTube ↗" ]
                        ]
                    , section [ class "evidence-section" ]
                        [ h3 [] [ text "Playback context" ]
                        , dl [ class "evidence-facts" ]
                            (List.map (\( key, caption ) -> fact caption (D.decodeValue (D.field key D.float) video |> Result.withDefault 0 |> formatDuration)) [ ( "foregroundSeconds", "On-tab" ), ( "backgroundSeconds", "Background" ), ( "unspecifiedSeconds", "Unspecified" ) ])
                        , p [ class "micro muted" ] [ text "Totals for this person and video in the selected range. Context is the tab's visibility, not proof of attention." ]
                        ]
                    , section [ class "evidence-section" ]
                        [ h3 [] [ text "Language signal" ]
                        , p [ class "micro muted" ] [ text "The latest recorded estimate, with the signals used to make it." ]
                        , dl [ class "evidence-facts" ] [ fact "Language" (field "lang" video), fact "Confidence" (field "conf" video), fact "Source" (field "source" video) ]
                        ]
                    , if evidence == E.null then
                        p [ class "evidence-empty" ] [ text "No source snapshot was attached to this observation. The recorded video and language fields are shown above." ]

                      else
                        div [ class "evidence-sections" ]
                            [ section [ class "evidence-section" ]
                                [ h3 [] [ text "Saved description" ]
                                , p [ class "evidence-description" ] [ text (fallback (field "description" evidence)) ]
                                , p [ class "micro muted" ]
                                    [ text
                                        ("Source: "
                                            ++ fallback (field "descriptionSource" evidence)
                                            ++ (if truncated then
                                                    " · Truncated by the collector"

                                                else
                                                    ""
                                               )
                                        )
                                    ]
                                ]
                            , section [ class "evidence-section" ]
                                [ h3 [] [ text "Audio & captions" ]
                                , dl [ class "evidence-facts two-columns" ] [ fact "Selected audio" (field "selectedAudioLanguage" evidence), fact "Default audio" (field "defaultAudioLanguage" evidence) ]
                                , div [ class "evidence-captions" ]
                                    (if List.isEmpty captions then
                                        [ p [ class "micro muted" ] [ text "No caption tracks recorded." ] ]

                                     else
                                        List.map
                                            (\caption ->
                                                span [ class "evidence-chip" ]
                                                    [ strong [] [ text (field "language" caption) ]
                                                    , text
                                                        (if field "kind" caption == "asr" then
                                                            " · Auto-generated"

                                                         else
                                                            " · Manual"
                                                        )
                                                    ]
                                            )
                                            captions
                                    )
                                ]
                            , section [ class "evidence-section" ]
                                [ h3 [] [ text "Text analysis" ]
                                , dl [ class "evidence-facts" ] [ fact "Estimate" (field "language" detector), fact "Engine" (field "engine" detector), fact "Input" (field "input" detector), fact "Detector status" (field "status" detector), fact "Algorithm" (field "algorithmVersion" evidence) ]
                                ]
                            ]
                    , details [ class "evidence-raw" ]
                        [ summary [] [ text "Raw source snapshot" ]
                        , p [ class "micro muted" ] [ text "Latest attached snapshot. Earlier observations and evidence revisions remain stored on the server." ]
                        , dl [] [ fact "SHA-256 evidence ID" (field "evidenceId" video), fact "Video ID" (field "videoId" video) ]
                        , pre [] [ code [] [ text (E.encode 2 evidence) ] ]
                        ]
                    ]
                , div [ class "evidence-footer" ] [ span [ class "micro muted" ] [ text "Saved evidence · not a fresh YouTube lookup" ], button [ type_ "button", onClick close ] [ text "Done" ] ]
                ]
        )
