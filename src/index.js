/* eslint-disable camelcase */
const Apify = require("apify");
const camelcaseKeysRecursive = require("camelcase-keys-recursive");

const {
  utils: { log },
} = Apify;
const {
  pivot,
  getReviews,
  validateInput,
  isMaxListing,
  makeInputBackwardsCompatible,
  getRequestFnc,
  enqueueDetailRequests,
  enqueueLocationQueryRequests,
  getCalendar,
  calculateOccupancyPercentage,
} = require("./tools");
const {
  getBuildListingUrlFnc,
  bookingDetailsUrl,
  callForHostInfo,
} = require("./api");
const {
  DEFAULT_MAX_PRICE,
  DEFAULT_MIN_PRICE,
  DEFAULT_MAX_REVIEWS,
  DEFAULT_CALENDAR_MONTHS,
  MAX_CONCURRENCY,
  HANDLE_REQUEST_TIMEOUT_SECS,
  MAX_KEY_LENGTH,
  DEFAULT_LOCALE,
} = require("./constants");

Apify.main(async () => {
  const input = await Apify.getInput();

  makeInputBackwardsCompatible(input);
  validateInput(input);

  const {
    simple = true,
    currency,
    locationQuery,
    minPrice = DEFAULT_MIN_PRICE,
    maxPrice = DEFAULT_MAX_PRICE,
    maxConcurrency = MAX_CONCURRENCY,
    checkIn,
    checkOut,
    startUrls = [],
    proxyConfiguration,
    includeReviews = true,
    maxReviews = DEFAULT_MAX_REVIEWS,
    maxListings,
    calendarMonths = DEFAULT_CALENDAR_MONTHS,
    addMoreHostInfo = false,
    debugLog = false,
    valuePairs,
  } = input;

  if (debugLog) {
    log.setLevel(log.LEVELS.DEBUG);
  }

  const proxy = await Apify.createProxyConfiguration(proxyConfiguration);
  if (Apify.isAtHome() && !proxy) {
    throw new Error(
      "WRONG INPUT: This actor must use Apify proxy or custom proxies when running on Apify platform!"
    );
  }

  const { abortOnMaxItems, persistState } = await isMaxListing(maxListings);
  Apify.events.on("persistState", persistState);

  const requestQueue = await Apify.openRequestQueue();
  const buildListingUrlFnc = getBuildListingUrlFnc({
    checkIn,
    checkOut,
    currency,
  });

  if (startUrls.length > 0) {
    log.info('"startUrls" is being used, the search will be ignored');
    await enqueueDetailRequests(requestQueue, startUrls, {
      minPrice,
      maxPrice,
    });
  } else {
    log.info(
      `"startUrls" isn't being used, will search now for "${locationQuery}"...`
    );
    await enqueueLocationQueryRequests(
      requestQueue,
      input,
      proxy,
      buildListingUrlFnc
    );
  }

  const crawler = new Apify.BasicCrawler({
    requestQueue,
    maxConcurrency,
    handleRequestTimeoutSecs: HANDLE_REQUEST_TIMEOUT_SECS,
    useSessionPool: true,
    maxRetries: 2,
    handleRequestFunction: async ({ request, session }) => {
      const {
        isHomeDetail,
        isPivoting,
        locale = DEFAULT_LOCALE,
      } = request.userData;

      const doReq = getRequestFnc(session, proxy, locale);

      if (isPivoting) {
        await pivot(request, requestQueue, doReq, buildListingUrlFnc);
      } else if (isHomeDetail) {
        const json = await doReq(request.url);
        const { pdp_listing_detail: detail } = json;

        // for (const entry of Object.entries(detail)) {
        //   log.info(JSON.stringify(entry));
        // }

        const { photos } = detail;

        // for (const entry of Object.entries(photos)) {
        //   log.info(JSON.stringify(entry));
        // }

        const photoUrls = photos.map((photo) => photo.large);

        const { listing_amenities } = detail;
        const available_amenities = listing_amenities
          .filter((amenity) => {
            return amenity.is_present;
          })
          .map((amenity) => {
            return amenity.id;
          });

        // for (const entry of Object.entries(listing_amenities)) {
        //   log.info(JSON.stringify(entry));
        // }

        // log.info("amenities");
        // log.info(JSON.stringify(available_amenities));

        // checking for no longer available details
        if (
          !detail &&
          json.error_message === "Unfortunately, this is no longer available."
        ) {
          return log.warning("Home detail is no longer available.", {
            url: request.url,
          });
        }

        if (!detail) {
          const requestUrl = new URL(request.url);
          const requestKey = `${requestUrl.host}${requestUrl.pathname}`
            .substring(0, MAX_KEY_LENGTH)
            .replaceAll("/", "-"); // '/' is not allowed in key name
          await Apify.setValue(`failed_${requestKey}`, json);
          throw new Error(
            `Unable to get details. Please, check key-value store to see the response. ${request.url}`
          );
        }

        log.info(`Saving home detail - ${detail.id}`);

        detail.reviews = includeReviews
          ? await getReviews(request.userData.id, doReq, maxReviews)
          : [];

        const result = camelcaseKeysRecursive(detail);

        const searchLocation = locationQuery.toLowerCase().split(",");
        const city = searchLocation[0].trim().replace(/\s/g, "-");
        const country = searchLocation[1].trim().replace(/\s/g, "-");

        const {
          locationTitle,
          starRating,
          guestLabel,
          p3SummaryTitle,
          lat,
          lng,
          roomAndPropertyType,
          reviews,
        } = result;
        const simpleResult = {
          url: `https://www.airbnb.com/rooms/${detail.id}`,
          airbnbId: detail.id,
          name: p3SummaryTitle,
          stars: starRating,
          numberOfGuests: parseInt(guestLabel.match(/\d+/)[0], 10),
          address: locationTitle,
          roomType: roomAndPropertyType,
          location: {
            lat,
            lng,
          },
          reviews,
          pricing: {},
          valuePairs,
          photos: photoUrls,
          amenities: available_amenities,
          city,
          country,
          bedrooms: detail.bedroom_label
            ? detail.bedroom_label.split(" ")[0]
            : 0,
          monthChecked: checkIn.split("-")[1],
          yearChecked: checkIn.split("-")[0],
          amenitiesDetails: listing_amenities,
          description: detail.sectioned_description,
          fullDetails: detail,
        };

        if (request.userData.pricing && request.userData.pricing.rate) {
          simpleResult.pricing = request.userData.pricing;
        } else {
          let pricingDetailsUrl = null;
          try {
            const { originalUrl } = request.userData;

            const checkInDate =
              (originalUrl
                ? new URL(
                    originalUrl,
                    "https://www.airbnb.com"
                  ).searchParams.get("check_in")
                : false) ||
              checkIn ||
              null;
            const checkOutDate =
              (originalUrl
                ? new URL(
                    originalUrl,
                    "https://www.airbnb.com"
                  ).searchParams.get("check_out")
                : false) ||
              checkOut ||
              null;

            if (checkInDate && checkOutDate) {
              pricingDetailsUrl = bookingDetailsUrl(
                detail.id,
                checkInDate,
                checkOutDate
              );
              log.info(
                `Requesting pricing details from ${checkInDate} to ${checkOutDate}`,
                { url: pricingDetailsUrl, id: detail.id }
              );
              const pricingResult = await doReq(pricingDetailsUrl);
              const { pdp_listing_booking_details } = pricingResult;
              const { available, rate_type: rateType } =
                pdp_listing_booking_details[0];

              // keys of pdp_listing_booking_details[0]
              //   [
              //   "available",
              //   "base_price_breakdown",
              //   "can_instant_book",
              //   "check_in",
              //   "check_out",
              //   "extra_guest_fee",
              //   "guests",
              //   "guest_details",
              //   "nights",
              //   "p3_cancellation_section",
              //   "p3_display_rate",
              //   "pricing_quote_request_uuid",
              //   "privacy_settings",
              //   "rate_type",
              //   "should_show_from_label",
              //   "id",
              //   "price",
              //   "localized_cancellation_policy_name",
              //   "cancellation_policy_label",
              //   "tax_amount_usd",
              //   "deposit_upsell_message_data",
              //   "discount_data",
              //   "localized_unavailability_message",
              //   "cancellation_policies",
              //   "price_context",
              //   "localized_book_it_button_text",
              //   "localized_unavailability_message_position_string",
              //   "bar_price",
              //   "is_eligible_for_hotel_booking_flow",
              //   "book_it_button_by_placement",
              //   "product_rate_sections",
              //   "localized_selected_dates",
              //   "redirect_to_messaging",
              //   "should_default_biz_toggle_for_covid19",
              //   "highlights_section"
              // ]

              //                             for (const entry of Object.entries(pdp_listing_booking_details[0])) {
              //                                 log.info(JSON.stringify(entry))
              //                             }

              const { price } = pdp_listing_booking_details[0];

              //   for (const entry of Object.entries(price)) {
              //     log.info(JSON.stringify(entry));
              //   }

              if (available) {
                simpleResult.pricing = {
                  rateType,
                  ...price,
                };
              }
            }
          } catch (e) {
            log.exception(e, "Error while retrieving pricing details", {
              url: pricingDetailsUrl,
              id: detail.id,
            });
          }
        }

        if (calendarMonths > 0) {
          simpleResult.calendar = await getCalendar(
            request,
            detail.id,
            checkIn,
            calendarMonths,
            doReq
          );
          simpleResult.occupancyPercentage = calculateOccupancyPercentage(
            simpleResult.calendar
          );
        }

        if (addMoreHostInfo && result.primaryHost) {
          try {
            const {
              user: { listings_count, total_listings_count },
            } = await doReq(callForHostInfo(result.primaryHost.id));
            result.primaryHost.hostUrl = `https://www.airbnb.com.vn/users/show/${result.primaryHost.id}`;
            result.primaryHost.listingsCount = listings_count;
            result.primaryHost.totalListingsCount = total_listings_count;
          } catch (e) {
            log.exception(e, "Error while retrieving host info", {
              url: request.url,
              id: result.primaryHost.id,
            });
          }
        }

        const isAbort = abortOnMaxItems();

        if (!isAbort) {
          if (simple) {
            await Apify.pushData(simpleResult);
          } else {
            const newResult = {
              ...simpleResult,
              ...result,
              locationTitle: undefined,
              starRating: undefined,
              guestLabel: undefined,
              p3SummaryTitle: undefined,
              lat: undefined,
              lng: undefined,
              roomAndPropertyType: undefined,
            };

            await Apify.pushData(newResult);
          }
        } else {
          await crawler.autoscaledPool.abort();
        }
      }
    },

    handleFailedRequestFunction: async ({ request }) => {
      log.warning(`Request ${request.url} failed too many times`);
      await Apify.pushData({
        "#debug": Apify.utils.createRequestDebugInfo(request),
      });
    },
  });

  await crawler.run();
  await persistState();

  log.info("Crawler finished.");
});
