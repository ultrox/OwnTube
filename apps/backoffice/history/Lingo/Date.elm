module Lingo.Date exposing (ordinal, short)


ordinal : String -> Maybe Int
ordinal value =
    case List.map String.toInt (String.split "-" value) of
        [ Just year, Just month, Just day ] ->
            let
                leap =
                    modBy 400 year == 0 || (modBy 4 year == 0 && modBy 100 year /= 0)

                months =
                    [ 31
                    , if leap then
                        29

                      else
                        28
                    , 31
                    , 30
                    , 31
                    , 30
                    , 31
                    , 31
                    , 30
                    , 31
                    , 30
                    , 31
                    ]

                maxDay =
                    List.drop (month - 1) months |> List.head |> Maybe.withDefault 0

                previous =
                    year - 1
            in
            if String.length value /= 10 || year < 1 || month < 1 || month > 12 || day < 1 || day > maxDay then
                Nothing

            else
                Just (previous * 365 + previous // 4 - previous // 100 + previous // 400 + List.sum (List.take (month - 1) months) + day)

        _ ->
            Nothing


short : String -> String
short value =
    case String.split "-" value of
        [ _, month, day ] ->
            let
                name =
                    String.toInt month |> Maybe.andThen (\n -> List.drop (n - 1) [ "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec" ] |> List.head) |> Maybe.withDefault month
            in
            name ++ " " ++ (String.toInt day |> Maybe.map String.fromInt |> Maybe.withDefault day)

        _ ->
            value
